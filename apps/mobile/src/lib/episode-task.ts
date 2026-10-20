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

// ── Making: steps and the time left ─────────────────────────────────────────

/** Where each step ends on the ring (the worker's own split): the script, voicing, then finishing. */
export const STEP_ENDS = [0.25, 0.95] as const;
export const STEPS = ["Writing the script", "Recording voices", "Finishing"] as const;
/** The step a point on the ring is in (the ring decides, so the step text changes as the ring crosses a tick). */
export const stepOf = (v: number) => (v >= STEP_ENDS[1] ? 2 : v >= STEP_ENDS[0] ? 1 : 0);

/** Below this there's too little to go on, so the estimate is just "~1 min left". */
export const ETA_FROM = 0.3;
export const ETA_EARLY = "~1 min left";
export const ETA_DONE = "Almost done";

/** The time left as it's shown: 5s steps, "Almost done" at the end, minutes above a minute. */
export type Eta = { eta: number | null; bucket: number | null; last: number };
export const newEta = (): Eta => ({ eta: null, bucket: null, last: 0 });

/** Raw seconds left: elapsed × (1 − p) / p at the sample, less the time since it was taken. */
export function rawSecondsLeft(p: number, elapsedAtSample: number, sampledAt: number, now: number): number {
  return Math.max(0, (elapsedAtSample * (1 - p)) / p - (now - sampledAt) / 1000);
}

/**
 * One tick of the estimate (about four a second). It counts down with the clock and eases toward the raw
 * figure: quickly when that's lower, only a little at a time when it's higher (a stall). The label moves in
 * 5s steps and only goes back up once the estimate is clearly higher, so it never flickers. `raw` is null
 * before there's enough to go on.
 */
export function tickEta(s: Eta, now: number, p: number, raw: number | null): string {
  const dt = s.last ? Math.min(250, Math.max(0, now - s.last)) : 0;
  s.last = now;
  if (raw == null || p < ETA_FROM) {
    s.eta = null;
    s.bucket = null;
    return ETA_EARLY;
  }
  if (s.eta == null) s.eta = raw;
  else {
    s.eta = Math.max(0, s.eta - dt / 1000);
    const d = raw - s.eta;
    if (d < 0) s.eta += d * (1 - Math.exp(-dt / 900));
    else s.eta += Math.min(d * (1 - Math.exp(-dt / 2500)), (dt / 1000) * 2);
  }
  const sec = s.eta;
  const b = Math.ceil(sec / 5) * 5;
  if (s.bucket == null || b < s.bucket || sec > s.bucket + 2) s.bucket = b;
  if (s.bucket <= 5) return ETA_DONE;
  if (s.bucket >= 60) return `~${Math.max(1, Math.round(sec / 60))} min left`;
  return `~${s.bucket}s left`;
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
export const DONE_MS = 2600;
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

