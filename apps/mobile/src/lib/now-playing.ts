import type { Phase } from "./episode-task.ts";

/**
 * Now playing (player-expand.html): what the pill's row carries, what the
 * expandable panel above it lists, and the handle's hint, app-wide. Plain
 * TypeScript (no React Native), so it can be tested on its own; `listen.ts`
 * wires it to the one audio player and the lock screen, and the pill's
 * watchers (`TrackedEpisodes`) report each episode it tracks.
 *
 * The collapsed row shows only what's playing: the episode in the player,
 * playing, paused or just finished. With nothing there, it shows the episode
 * asked for here that's ready (the newest), or else the one being made that's
 * closest to done. Everything else waits in the panel, ordered by how soon
 * you'll hear it: Up next (chosen with "Play after this"), Ready (made and not
 * yet played), Making.
 *
 * The handle on the row's top edge is the hint: it fills with the progress of
 * the episode closest to done while one is being made, and turns blue when one
 * becomes ready, until the panel is opened or the episode plays.
 */

/** Where tapping the row's text goes, and what the lock screen says. */
export type NowPlayingMeta = {
  itemId: string;
  title: string;
  /** In a letter: that letter, at this piece's page. Otherwise the item's own reader. */
  home: { kind: "letter"; letterId: string; today: boolean; page: number } | { kind: "item" };
  /** Under the title on the lock screen: "Founder Signal · No. 14 · Piece 2". */
  subtitle: string;
  artworkUrl: string | null;
  /** For the Library's Podcasts tab: "Author · No. 14 · Piece 2" (the author, or the source outside a letter). */
  author?: string | null;
  letterNumber?: number | null;
  position?: number | null;
};

/** One episode the pill tracks, as its watcher last reported it. */
export type TrackedEpisode = {
  itemId: string;
  phase: Phase;
  /** Its row is open (not folded away after Listened or Stopped). */
  open: boolean;
  /** Making: how far along, 0 → 1 (1 once ready). */
  progress: number;
  /** Not started and not listened (the Podcasts tab's New). */
  unplayed: boolean;
  /** When it went on the Podcasts list (ms): newer first, after the ones that just became ready. */
  addedAt: number;
};

/** The phases in which the episode in the player is "what's playing". */
export const PLAYER_PHASES: readonly Phase[] = ["playing", "paused", "done"];

export type HintKind = "none" | "making" | "ready";

export type PlayerState = {
  /** The piece whose audio is loaded in the player. */
  player: string | null;
  tracked: ReadonlyMap<string, TrackedEpisode>;
  /** Up next, in order: chosen with "Play after this". */
  queue: readonly string[];
  /** Asked for here and not yet played, oldest first: what the row may show when nothing is in the player. */
  asked: readonly string[];
  /** When an episode became ready while the app watched it (ms). */
  readyAt: ReadonlyMap<string, number>;
  /** Ready ones the reader has seen (the panel opened, or it played): the handle no longer calls them out. */
  seen: ReadonlySet<string>;
};

export type PlayerView = {
  /** In the player and playing, paused or just finished: the row and the panel's Now playing. Null: nothing. */
  now: string | null;
  /** What the collapsed row shows (null: no row). */
  row: string | null;
  /** The panel's Now playing: `now`, or the ready episode the row offers when nothing is playing. */
  top: string | null;
  upNext: string[];
  ready: string[];
  making: string[];
  hint: { kind: HintKind; progress: number };
};

const isReady = (t: TrackedEpisode | undefined) => !!t && t.phase === "ready" && t.unplayed;

/**
 * Everything the pill shows, from the state. `playbackOnly` is the Podcasts tab: its list rows show making and
 * ready, so the row is only for what's in the player and the handle stays plain.
 */
export function selectView(s: PlayerState, { playbackOnly = false }: { playbackOnly?: boolean } = {}): PlayerView {
  const t = (id: string) => s.tracked.get(id);
  const p = s.player ? t(s.player) : undefined;
  const now = s.player && p && p.open && PLAYER_PHASES.includes(p.phase) ? s.player : null;
  const fresh = (id: string) => s.readyAt.get(id) ?? 0;

  const tracked = [...s.tracked.values()].filter((e) => e.itemId !== now);
  const queued = new Set(s.queue);
  // Up next: still ready (one that's gone or failed drops out); unknown ones wait for their watcher.
  const upNext = s.queue.filter((id) => id !== now && (!t(id) || t(id)!.phase === "ready"));
  const readyAll = tracked
    .filter((e) => isReady(e) && !queued.has(e.itemId))
    .sort((a, b) => fresh(b.itemId) - fresh(a.itemId) || b.addedAt - a.addedAt)
    .map((e) => e.itemId);
  const making = tracked
    .filter((e) => e.phase === "making")
    .sort((a, b) => b.progress - a.progress || b.addedAt - a.addedAt)
    .map((e) => e.itemId);

  let row = now;
  if (!row && !playbackOnly) {
    // Asked for here: the newest ready, else the one closest to done, else whatever its row still says (failed, Stopped).
    const asked = s.asked.map(t).filter((e): e is TrackedEpisode => !!e && e.open && e.itemId !== s.player);
    const ready = asked.filter(isReady).sort((a, b) => fresh(b.itemId) - fresh(a.itemId));
    const mk = asked.filter((e) => e.phase === "making").sort((a, b) => b.progress - a.progress);
    const other = asked.filter((e) => e.phase !== "ready" && e.phase !== "making").reverse();
    row = ready[0]?.itemId ?? mk[0]?.itemId ?? other[0]?.itemId ?? null;
  }

  const top = now ?? (row && isReady(t(row)) && !queued.has(row) ? row : null);
  const ready = readyAll.filter((id) => id !== top);

  let hint: PlayerView["hint"] = { kind: "none", progress: 0 };
  if (!playbackOnly) {
    const calling = readyAll.some((id) => id !== row && s.readyAt.has(id) && !s.seen.has(id));
    const others = making.filter((id) => id !== row);
    const progress = others.reduce((m, id) => Math.max(m, t(id)!.progress), 0);
    if (calling) hint = { kind: "ready", progress };
    else if (others.length) hint = { kind: "making", progress };
  }

  return { now, row, top, upNext, ready, making, hint };
}

const sameTracked = (a: TrackedEpisode | undefined, b: TrackedEpisode) =>
  !!a && a.phase === b.phase && a.open === b.open && a.progress === b.progress && a.unplayed === b.unplayed && a.addedAt === b.addedAt;

export type NowPlaying = ReturnType<typeof createNowPlaying>;

export function createNowPlaying(clock: () => number = Date.now) {
  let player: string | null = null;
  const metas = new Map<string, NowPlayingMeta>();
  const tracked = new Map<string, TrackedEpisode>();
  let queue: string[] = [];
  let asked: string[] = [];
  const readyAt = new Map<string, number>();
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  /** Views are worked out once per change (useSyncExternalStore wants the same object until then). */
  let views: { all?: PlayerView; playback?: PlayerView } = {};
  const emit = () => {
    views = {};
    listeners.forEach((l) => l());
  };
  const state = (): PlayerState => ({ player, tracked, queue, asked, readyAt, seen });

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    meta: (id: string | null) => (id ? (metas.get(id) ?? null) : null),
    /** What a piece is (its reader says, when it shows). */
    describe(meta: NowPlayingMeta) {
      const was = metas.get(meta.itemId);
      if (was && JSON.stringify(was) === JSON.stringify(meta)) return;
      metas.set(meta.itemId, meta);
      emit();
    },
    playerItem: () => player,
    /** The player loaded this piece's audio. */
    loaded(id: string) {
      if (player === id) return;
      player = id;
      emit();
    },
    /** Asked for here (making starts): with nothing in the player, the row may show it. */
    ask(id: string) {
      asked = [...asked.filter((x) => x !== id), id];
      emit();
    },
    /** It played (from anywhere): it's what's playing now, so it no longer waits in Up next or for a first play. */
    played(id: string) {
      queue = queue.filter((x) => x !== id);
      asked = asked.filter((x) => x !== id);
      seen.add(id);
      emit();
    },
    /** Its row folded away (Listened or Stopped): it no longer offers itself to the row. */
    folded(id: string) {
      if (!asked.includes(id)) return;
      asked = asked.filter((x) => x !== id);
      emit();
    },
    /** A watcher's latest on one episode. Making → ready is when it becomes "just ready" for the handle. */
    report(t: TrackedEpisode) {
      const was = tracked.get(t.itemId);
      if (sameTracked(was, t)) return;
      if (was?.phase === "making" && t.phase === "ready") {
        readyAt.set(t.itemId, clock());
        seen.delete(t.itemId);
      }
      tracked.set(t.itemId, { ...t });
      emit();
    },
    /** No longer watched (played and gone from New, or removed from the Podcasts list). */
    untrack(id: string) {
      if (!tracked.delete(id)) return;
      emit();
    },
    /** "Play after this": to the end of Up next (once; never the episode already in the player). */
    playAfter(id: string) {
      if (id === player || queue.includes(id)) return;
      queue = [...queue, id];
      emit();
    },
    /** ✕ on Up next: back to Ready. */
    unqueue(id: string) {
      if (!queue.includes(id)) return;
      queue = queue.filter((x) => x !== id);
      emit();
    },
    /** The panel opened: whatever is ready has been seen, and the handle goes plain. */
    sawPanel() {
      let changed = false;
      for (const id of readyAt.keys())
        if (!seen.has(id)) {
          seen.add(id);
          changed = true;
        }
      if (changed) emit();
    },
    /**
     * The episode in the player played to the end: the next one in Up next that's still ready, taken off the
     * queue (the caller plays it), or null for none. Nothing plays on its own unless the reader queued it.
     */
    advance(): string | null {
      const next = queue.find((id) => id !== player && (!tracked.get(id) || tracked.get(id)!.phase === "ready")) ?? null;
      if (next) {
        queue = queue.filter((x) => x !== next);
        emit();
      }
      return next;
    },
    queue: () => queue,
    state,
    /** The pill's view (the same object until something changes). */
    view(playbackOnly = false): PlayerView {
      const k = playbackOnly ? "playback" : "all";
      return (views[k] ??= selectView(state(), { playbackOnly }));
    },
  };
}

/** "Founder Signal · No. 14 · Piece 2" (or the source, for a piece outside a letter). */
export function lockSubtitle(letterNumber: number | null, position: number | null, source: string | null): string {
  if (letterNumber != null && position != null) return `Founder Signal · No. ${letterNumber} · Piece ${position}`;
  return ["Founder Signal", source].filter(Boolean).join(" · ");
}
