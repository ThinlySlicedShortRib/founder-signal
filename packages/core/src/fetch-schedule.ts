/** How often a healthy feed or channel is polled. */
export const FEED_POLL_INTERVAL_MS = 60 * 60 * 1000;
/** Failure backoff doubles from the base and is capped. */
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** After this many failures in a row the source stops being polled until someone edits it. */
export const MAX_CONSECUTIVE_FAILURES = 10;

export interface FetchOutcome {
  ok: boolean;
  /** `url` sources are ingested once. */
  oneShot: boolean;
  /** Failures in a row before this attempt. */
  previousFailures: number;
}

export interface NextFetch {
  nextFetchAt: Date | null;
  consecutiveFailures: number;
}

export function nextFetch(now: Date, { ok, oneShot, previousFailures }: FetchOutcome): NextFetch {
  if (ok) {
    return { nextFetchAt: oneShot ? null : new Date(now.getTime() + FEED_POLL_INTERVAL_MS), consecutiveFailures: 0 };
  }
  const failures = previousFailures + 1;
  if (failures >= MAX_CONSECUTIVE_FAILURES) return { nextFetchAt: null, consecutiveFailures: failures };
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return { nextFetchAt: new Date(now.getTime() + delay), consecutiveFailures: failures };
}
