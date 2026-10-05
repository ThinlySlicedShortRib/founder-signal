import { type RankCandidate, type RankProfile, scoreCandidate } from "./ranking.ts";

/**
 * Enough to pick from (build plan §6.2, "Every letter has at least three
 * pieces"): the rules for how far collection goes before a letter is allowed
 * to be short. No I/O, so every rule is unit-tested.
 *
 * When a letter has fewer usable candidates than it needs, collection
 * escalates in a fixed order and stops as soon as there are enough:
 *
 *   own         the usual candidates (followed sources in CANDIDATE_WINDOW_DAYS,
 *               discovered pages found in DISCOVERED_CANDIDATE_DAYS, trusted feeds)
 *   widened     the same, over WIDE_CANDIDATE_WINDOW_DAYS
 *   shared_pool good items other users' discovery found, or trusted publishers
 *               produced, that match this user's brief (ranked with a penalty)
 *   discovery   a discovery run for this letter (once per letter); the letter
 *               is held until it ends, then collected again
 *
 * Only then does a letter go out short (or get skipped, by the user's
 * short-letter policy), with a reason saying why.
 */

/** No letter is planned with fewer pieces than this; `schedule.item_count` below it counts as this. */
export const MIN_PIECES = 3;
/** The wider window for followed sources and discovered pages, when the usual one has too little. */
export const WIDE_CANDIDATE_WINDOW_DAYS = 180;
/**
 * Candidates wanted beyond the pieces themselves, so a piece that fails
 * verification can be replaced. The cheap steps (widening, the shared pool)
 * run until there are this many spare; discovery only runs when there aren't
 * even enough for the pieces.
 */
export const RESERVE_DEPTH = 4;
/** Ranked entries kept after the picks, for substitution (at least RESERVE_DEPTH). */
export const RANKED_RESERVE = 8;
/** Shared-pool items scanned (newest first) and, of those matching the brief, the most taken. */
export const SHARED_POOL_SCAN = 200;
export const SHARED_POOL_MAX = 20;
/** A shared-pool item must match the brief at least this much (a topic, "lately" or leaning match). */
export const SHARED_POOL_MIN_FIT = 1;

export const collectionSteps = ["own", "widened", "shared_pool", "discovery"] as const;
export type CollectionStep = (typeof collectionSteps)[number];

/** Pieces a letter is planned with: the schedule's count, never below MIN_PIECES. */
export function piecesWanted(itemCount: number | null | undefined): number {
  return Math.max(MIN_PIECES, Math.floor(itemCount ?? MIN_PIECES));
}

/** Candidates collection aims for before it stops escalating through the cheap steps. */
export function candidateTarget(wanted: number): number {
  return wanted + RESERVE_DEPTH;
}

/**
 * Whether discovery can still run for this letter: `available` (it hasn't,
 * and discovery is on), `ran` (a run for this letter has ended, or the letter
 * was already held for one) or `off` (DISCOVERY=none).
 */
export type DiscoveryAvailability = "available" | "ran" | "off";

/**
 * The next escalation step, or null when collection should stop: there are
 * enough, or nothing is left to try. `done` is the steps already run in this
 * pass (`own` always runs first).
 */
export function nextCollectionStep({
  found,
  wanted,
  done,
  discovery,
}: {
  found: number;
  wanted: number;
  done: readonly CollectionStep[];
  discovery: DiscoveryAvailability;
}): CollectionStep | null {
  if (!done.includes("own")) return "own";
  const target = candidateTarget(wanted);
  if (found < target && !done.includes("widened")) return "widened";
  if (found < target && !done.includes("shared_pool")) return "shared_pool";
  if (found < wanted && discovery === "available" && !done.includes("discovery")) return "discovery";
  return null;
}

/** The part of a user's brief a shared-pool item has to match. */
export type PoolBrief = Pick<RankProfile, "topics" | "lately" | "leanings">;

const BRIEF_SIGNALS = new Set(["topic", "lately", "leaning"]);

/**
 * How well a candidate matches the user's brief (topics, "lately", the
 * leanings they chose): the same matching as ranking, counting only those
 * signals. A shared-pool item needs SHARED_POOL_MIN_FIT.
 */
export function briefFit(c: RankCandidate, brief: PoolBrief, now: Date): number {
  const s = scoreCandidate(c, { ...brief, reviews: [] }, now);
  return s.signals.filter((x) => BRIEF_SIGNALS.has(x.kind)).reduce((sum, x) => sum + x.weight, 0);
}

/** Shared-pool items that match the brief, best match first (ties: newest, then ID), at most `max`. */
export function sharedPoolMatches<T extends RankCandidate>(pool: T[], brief: PoolBrief, { now, max = SHARED_POOL_MAX }: { now: Date; max?: number }): T[] {
  return pool
    .map((c) => ({ c, fit: briefFit(c, brief, now) }))
    .filter((x) => x.fit >= SHARED_POOL_MIN_FIT)
    .sort(
      (a, b) =>
        b.fit - a.fit ||
        (b.c.publishedAt?.getTime() ?? 0) - (a.c.publishedAt?.getTime() ?? 0) ||
        (a.c.itemId < b.c.itemId ? -1 : 1),
    )
    .slice(0, max)
    .map((x) => x.c);
}

/** One escalation step as recorded on the letter: the candidates it had after the step. */
export interface CollectionStepRecord {
  step: CollectionStep;
  /** Candidates after this step. */
  total: number;
  /** Candidates it added. */
  added: number;
}

/**
 * Why a letter has fewer pieces than wanted, for `letter.short_reason`
 * (shown in Dev tools). `discovery` says what happened to the discovery step.
 */
export function shortReason({
  wanted,
  pieces,
  candidates,
  discovery,
  rejected = 0,
}: {
  wanted: number;
  pieces: number;
  candidates: number;
  discovery: DiscoveryAvailability;
  rejected?: number;
}): string {
  const tried = `own sources, a ${WIDE_CANDIDATE_WINDOW_DAYS}-day window and the shared pool`;
  const disc =
    discovery === "off" ? "discovery is off" : discovery === "available" ? "discovery not needed at collection" : "discovery already ran for this letter";
  const verified = rejected ? `; ${rejected} failed verification and no substitute was left` : "";
  return `${pieces} of ${wanted} pieces: ${candidates} usable candidate${candidates === 1 ? "" : "s"} after ${tried}; ${disc}${verified}`;
}
