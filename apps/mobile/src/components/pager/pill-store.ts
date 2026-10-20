import type { ReactNode } from "react";

/**
 * The state behind the one morphing pill. Plain TypeScript (no React Native),
 * so it can be tested on its own.
 *
 * Owners claim the pill with a slot (a `<Pill mode=…>` under a `PillProvider`).
 * The newest claim wins: a slot claims when it mounts and again when its mode
 * changes. The winner is the pill's `current` layer; whatever it replaces
 * becomes an `exiting` layer, frozen as it last looked, until the outlet drops
 * it after its fade-out. Updates within one mode (a new label, a ticking time
 * left) refresh `current` in place and are not a change of layer.
 *
 * When the last slot goes away the pill holds its last look for `GRACE_MS`
 * first, because owners hand over across a render or two (the Reader lets go
 * of the pill before the pager takes it back); a claim inside that window
 * morphs straight from the old look.
 *
 * Separately, the pill can carry a status row above its controls (a
 * background task, e.g. a Listen episode being made). It's claimed on its own
 * (`setStatus`), not with a mode, so it stays put while the controls under it
 * change hands or morph. The newest status claim wins; letting go of it is
 * held for `GRACE_MS` like the pill, so a handover doesn't fold and regrow it.
 */

export const GRACE_MS = 100;

export type PillEntry = {
  mode: string;
  label: string;
  node: ReactNode;
  /** Covered by a dialog: the pill fades out but keeps its place and contents. */
  hidden: boolean;
  z: number;
};

export type PillLayer = PillEntry & {
  /** Unique per appearance; the outlet's React key. */
  id: number;
  /** slot:mode. A layer coming back while it's still fading out is revived, not remounted. */
  key: string;
  /** Its slot has unmounted (during the grace period): shown, but not tappable. */
  orphan: boolean;
};

export type PillSnapshot = {
  current: PillLayer | null;
  exiting: readonly PillLayer[];
  /** The status row's contents, or null for none. */
  status: ReactNode | null;
};

type Slot = PillEntry & { order: number };

export type PillStore = ReturnType<typeof createPillStore>;

export function createPillStore(timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = defaultTimers) {
  const slots = new Map<string, Slot>();
  const listeners = new Set<() => void>();
  let order = 0;
  let layerId = 0;
  let snapshot: PillSnapshot = { current: null, exiting: [], status: null };
  let grace: unknown = null;
  const statuses = new Map<string, { node: ReactNode; order: number }>();
  let statusGrace: unknown = null;

  function emit(next: Omit<PillSnapshot, "status"> & { status?: ReactNode | null }) {
    snapshot = { ...next, status: next.status === undefined ? snapshot.status : next.status };
    for (const l of listeners) l();
  }

  function winner(): [string, Slot] | null {
    let best: [string, Slot] | null = null;
    for (const entry of slots) if (!best || entry[1].order > best[1].order) best = entry;
    return best;
  }

  function cancelGrace() {
    if (grace !== null) timers.clear(grace);
    grace = null;
  }

  function reconcile() {
    const w = winner();
    const { current, exiting } = snapshot;
    if (!w) {
      if (!current || current.orphan) return;
      // Hold the last look (not tappable) for a moment in case another owner claims it.
      emit({ current: { ...current, orphan: true }, exiting });
      cancelGrace();
      grace = timers.set(() => {
        grace = null;
        if (winner() || !snapshot.current) return;
        emit({ current: null, exiting: [...snapshot.exiting, snapshot.current] });
      }, GRACE_MS);
      return;
    }
    cancelGrace();
    const [slotId, slot] = w;
    const key = `${slotId}:${slot.mode}`;
    const entry: PillEntry = { mode: slot.mode, label: slot.label, node: slot.node, hidden: slot.hidden, z: slot.z };
    if (current && current.key === key) {
      emit({ current: { ...current, ...entry, orphan: false }, exiting });
      return;
    }
    const revived = exiting.find((l) => l.key === key);
    const rest = exiting.filter((l) => l !== revived);
    const next: PillLayer = revived ? { ...revived, ...entry, orphan: false } : { ...entry, id: ++layerId, key, orphan: false };
    emit({ current: next, exiting: current ? [...rest, current] : rest });
  }

  function reconcileStatus() {
    let best: { node: ReactNode; order: number } | null = null;
    for (const s of statuses.values()) if (s.node != null && s.node !== false && (!best || s.order > best.order)) best = s;
    if (best) {
      if (statusGrace !== null) timers.clear(statusGrace);
      statusGrace = null;
      if (snapshot.status !== best.node) emit({ ...snapshot, status: best.node });
      return;
    }
    if (snapshot.status === null || statusGrace !== null) return;
    statusGrace = timers.set(() => {
      statusGrace = null;
      emit({ ...snapshot, status: null });
    }, GRACE_MS);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    /** Claim or update a slot. A new slot, or a new mode, claims the pill. */
    set(slotId: string, entry: PillEntry) {
      const was = slots.get(slotId);
      slots.set(slotId, { ...entry, order: !was || was.mode !== entry.mode ? ++order : was.order });
      reconcile();
    },
    release(slotId: string) {
      if (slots.delete(slotId)) reconcile();
    },
    /** Claim or update the status row above the controls; null lets it fold. */
    setStatus(slotId: string, node: ReactNode | null) {
      const was = statuses.get(slotId);
      statuses.set(slotId, { node, order: was ? was.order : ++order });
      reconcileStatus();
    },
    releaseStatus(slotId: string) {
      if (statuses.delete(slotId)) reconcileStatus();
    },
    /** The outlet calls this once an exiting layer has faded out. */
    drop(id: number) {
      const { current, exiting } = snapshot;
      if (!exiting.some((l) => l.id === id)) return;
      emit({ current, exiting: exiting.filter((l) => l.id !== id) });
    },
  };
}

const defaultTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
};
