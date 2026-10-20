import type { EpisodeView } from "@fs/schema";

/**
 * A piece's Listen episode as one background task: what the pill's status
 * row, the Listen card and the cover's headphones button all show. Plain
 * TypeScript (no React Native), so it can be tested on its own; `listen.ts`
 * wires it to the API, the query cache and the one audio player.
 *
 * The server says how far the episode is (`useEpisode`), the player says
 * what's playing, and this keeps the rest: whether the reader asked for it
 * here, the Stop confirm, "Stopped", "Listened" and the row being folded away.
 */

export type Phase = "idle" | "making" | "ready" | "playing" | "paused" | "failed" | "done" | "stopped";

/** What the reader has done with a piece's episode in this session. */
export type TaskLocal = {
  /** Asked for here (the headphones, the card, Retry): a failure then shows in the pill too. */
  started: boolean;
  /** The POST is in flight. */
  requesting: boolean;
  requestFailed: boolean;
  /** "Stop this episode?" is showing. */
  confirm: boolean;
  confirmAt: number;
  /** "Stopped", for a moment before the row folds. */
  stopped: boolean;
  /** "Listened", for a few seconds after the end. */
  finished: boolean;
  /** The pill's row has folded away (after Listened or Stopped); the card still shows the episode. */
  hidden: boolean;
};

export const IDLE_LOCAL: TaskLocal = { started: false, requesting: false, requestFailed: false, confirm: false, confirmAt: 0, stopped: false, finished: false, hidden: false };

/** The one audio player, as far as a piece's task cares. */
export type PlayState = { itemId: string | null; playing: boolean; at: number; duration: number };

const BUSY: EpisodeView["status"][] = ["queued", "scripting", "voicing"];
export const isBusy = (e: Pick<EpisodeView, "status"> | null | undefined) => !!e && BUSY.includes(e.status);

export function phaseOf(server: Pick<EpisodeView, "status"> | null | undefined, local: TaskLocal, play: PlayState | null, itemId: string): Phase {
  if (local.stopped) return "stopped";
  if (local.requesting || isBusy(server)) return "making";
  if (local.requestFailed || server?.status === "failed") return "failed";
  if (server?.status !== "ready") return "idle";
  const mine = !!play && play.itemId === itemId;
  if (mine && play.playing) return "playing";
  if (local.finished) return "done";
  if (mine && play.at > 0.5) return "paused";
  return "ready";
}

/** Whether the pill grows its status row. A failure from another day stays in the card. */
export function rowShows(phase: Phase, local: TaskLocal): boolean {
  if (phase === "idle" || local.hidden) return phase === "stopped";
  if (phase === "failed") return local.started;
  return true;
}

/** Making: the step the worker is on (from its status and progress) and about how long that leaves, as on the mock. */
export function makingStep(server: Pick<EpisodeView, "status" | "progress"> | null | undefined): { step: string; eta: string } {
  if (!server || server.status === "queued" || server.status === "scripting") return { step: "Writing the script", eta: "~1 min" };
  if ((server.progress ?? 0) >= 0.95) return { step: "Finishing", eta: "a few sec" };
  return { step: "Recording voices", eta: "~30 sec" };
}

/** The ring's target: the server's number (never backwards), and full once it's ready. */
export function ringTarget(shown: number, server: Pick<EpisodeView, "status" | "progress"> | null | undefined): number {
  if (!server) return shown;
  if (server.status === "ready") return 1;
  return Math.max(shown, Math.min(1, server.progress ?? 0));
}

export const fmtTime = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export const minutesLabel = (seconds: number | null | undefined) => `${Math.max(1, Math.round((seconds ?? 0) / 60))} min`;

// ── The local half, shared by every view of every piece ─────────────────────

/** How long "Stop this episode?" waits before it counts as Keep. */
export const CONFIRM_MS = 5000;
/** "Stopped" shows this long, then the row folds. */
export const STOPPED_MS = 1500;
/** "Listened" shows this long, then the row folds. */
export const DONE_MS = 3600;
/** A scroll this soon after the confirm opened is the tap that opened it settling, not a scroll away. */
const SCROLL_GRACE_MS = 300;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void; now: () => number };

export type EpisodeTasks = ReturnType<typeof createEpisodeTasks>;

export function createEpisodeTasks(timers: Timers = defaultTimers) {
  const tasks = new Map<string, TaskLocal>();
  const pending = new Map<string, unknown>();
  const listeners = new Set<() => void>();

  const get = (id: string) => tasks.get(id) ?? IDLE_LOCAL;
  function put(id: string, patch: Partial<TaskLocal>) {
    tasks.set(id, { ...get(id), ...patch });
    for (const l of listeners) l();
  }
  /** One timer per piece: a newer one (Keep, Stop, Listened) replaces it. */
  function later(id: string, ms: number, fn: () => void) {
    cancel(id);
    pending.set(
      id,
      timers.set(() => {
        pending.delete(id);
        fn();
      }, ms),
    );
  }
  function cancel(id: string) {
    const t = pending.get(id);
    if (t !== undefined) timers.clear(t);
    pending.delete(id);
  }

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    get,
    /** Asked for (or asked again): the row grows and stays until it's dealt with. */
    begin(id: string) {
      cancel(id);
      put(id, { started: true, requesting: true, requestFailed: false, confirm: false, stopped: false, finished: false, hidden: false });
    },
    requested(id: string, ok: boolean) {
      put(id, { requesting: false, requestFailed: !ok });
    },
    /** Playing again (from the card, or after Listened): the row comes back. */
    show(id: string) {
      if (get(id).hidden || get(id).finished) {
        cancel(id);
        put(id, { hidden: false, finished: false });
      }
    },
    askStop(id: string) {
      put(id, { confirm: true, confirmAt: timers.now() });
      later(id, CONFIRM_MS, () => put(id, { confirm: false }));
    },
    keep(id: string) {
      if (!get(id).confirm) return;
      cancel(id);
      put(id, { confirm: false });
    },
    /** Tapped elsewhere or scrolled: every open confirm keeps going. */
    dismiss({ scroll = false }: { scroll?: boolean } = {}) {
      for (const [id, t] of tasks) {
        if (!t.confirm || (scroll && timers.now() - t.confirmAt < SCROLL_GRACE_MS)) continue;
        cancel(id);
        put(id, { confirm: false });
      }
    },
    anyConfirm: () => [...tasks.values()].some((t) => t.confirm),
    /** Stop: "Stopped" for a moment, then the row folds. The caller cancels the job. */
    stop(id: string) {
      put(id, { confirm: false, stopped: true, started: false, requesting: false, requestFailed: false });
      later(id, STOPPED_MS, () => put(id, { stopped: false, hidden: true }));
    },
    /** The episode played to the end: "Listened", then the row folds. */
    finish(id: string) {
      if (get(id).finished) return;
      put(id, { finished: true });
      later(id, DONE_MS, () => put(id, { finished: false, hidden: true }));
    },
  };
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

