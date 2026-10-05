import { HELD_LETTER_MAX_MINUTES, localDateOf, piecesWanted, SHARED_POOL_SCAN, sharedPoolMatches, WIDE_CANDIDATE_WINDOW_DAYS } from "@fs/core";
import { type Db, loadPoolBrief, ownCandidateIds, schema, sharedPoolRows } from "@fs/db";
import type { LetterProgress, LetterStage } from "@fs/schema";
import { and, eq } from "drizzle-orm";
import type { DiscoverQueue, LetterQueue } from "./letter-queue.ts";

const { discoveryRun, letter, schedule } = schema;

export interface OnDemandLetterDeps {
  db: Db;
  /** Starts a letter's pipeline; null locally, where the dev runner's watchdog picks it up. */
  letterQueue: LetterQueue | null;
  /** Starts a discovery run; null locally, where the dev runner's letter sweep starts it. */
  discoverQueue: DiscoverQueue | null;
  /** False with DISCOVERY=none: letters only use the sources the user follows. */
  discovery: boolean;
}

/** With a queue, the watchdog is only a backstop this far ahead; without one (locally) it starts the letter. */
const QUEUED_WATCHDOG_MINUTES = 10;

/**
 * A letter put together now rather than on the schedule (§6.1): the first
 * letter (`first`, once per user) or a test letter (`test#<uuid>`). It never
 * touches `next_run_at`. With `discoverFirst` (and discovery on), it's held
 * in `scheduled` while a discovery run with the same occurrence ID searches
 * the web for the user (§6.3a); the workers start it when the run has ended
 * and its pages are extracted, or after HELD_LETTER_MAX_MINUTES at the latest
 * (apps/workers/src/letters/held.ts). Otherwise it starts straight away.
 *
 * `(user_id, occurrence_id)` is unique, so asking twice for the same
 * occurrence returns the letter made the first time.
 */
export async function createOnDemandLetter(
  deps: OnDemandLetterDeps,
  { userId, occurrenceId, isTest, discoverFirst }: { userId: string; occurrenceId: string; isTest: boolean; discoverFirst: boolean },
): Promise<{ letterId: string; created: boolean }> {
  const { db, letterQueue, discoverQueue } = deps;
  const [s] = await db.select({ timeZone: schedule.timeZone }).from(schedule).where(eq(schedule.userId, userId));
  const now = new Date();
  const hold = discoverFirst && deps.discovery;
  const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

  const out = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(letter)
      .values({
        userId,
        occurrenceId,
        isTest,
        scheduledFor: now,
        localDate: localDateOf(now, s?.timeZone ?? "UTC"),
        awaitingDiscovery: hold,
        watchdogAt: hold ? minutes(HELD_LETTER_MAX_MINUTES) : letterQueue ? minutes(QUEUED_WATCHDOG_MINUTES) : now,
      })
      .onConflictDoNothing({ target: [letter.userId, letter.occurrenceId] })
      .returning({ id: letter.id });
    if (!row) {
      const [existing] = await tx
        .select({ id: letter.id })
        .from(letter)
        .where(and(eq(letter.userId, userId), eq(letter.occurrenceId, occurrenceId)));
      return { letterId: existing!.id, created: false, runId: null };
    }
    // If a run for this occurrence already exists, the letter waits on that one.
    const [run] = hold
      ? await tx
          .insert(discoveryRun)
          .values({ userId, occurrenceId, letterDueAt: now })
          .onConflictDoNothing({ target: [discoveryRun.userId, discoveryRun.occurrenceId] })
          .returning({ id: discoveryRun.id })
      : [];
    return { letterId: row.id, created: true, runId: run?.id ?? null };
  });
  if (!out.created) return { letterId: out.letterId, created: false };

  if (hold) {
    // If this send is lost, the letter sweep sends it again.
    if (out.runId && discoverQueue) {
      await discoverQueue.start(out.runId).catch((err: Error) => {
        console.warn(JSON.stringify({ level: "warn", message: "couldn't queue discovery for a held letter", error: err.message }));
      });
    }
  } else if (letterQueue) {
    try {
      await letterQueue.start(out.letterId);
    } catch (err) {
      // The watchdog will start it; make that soon.
      await db.update(letter).set({ watchdogAt: now }).where(eq(letter.id, out.letterId));
      console.warn(JSON.stringify({ level: "warn", message: "couldn't queue a letter", error: (err as Error).message }));
    }
  }
  return { letterId: out.letterId, created: true };
}

/**
 * Whether there's already enough to make a letter from, by the collect
 * step's rule (apps/workers/src/letters/steps.ts, @fs/core letter-supply.ts):
 * at least `piecesWanted` usable candidates from the user's own sources and
 * discoveries over the widened window, plus shared-pool items that match
 * their brief. If not, the collect step would hold the letter for discovery
 * anyway, so an on-demand letter discovers first.
 */
export async function hasEnoughToPick(db: Db, userId: string): Promise<boolean> {
  const [s] = await db.select({ itemCount: schedule.itemCount }).from(schedule).where(eq(schedule.userId, userId));
  const wanted = piecesWanted(s?.itemCount);
  const window = { followedDays: WIDE_CANDIDATE_WINDOW_DAYS, discoveredDays: WIDE_CANDIDATE_WINDOW_DAYS };
  const own = await ownCandidateIds(db, { userId, window, limit: wanted });
  if (own.length >= wanted) return true;
  const [pool, brief] = await Promise.all([
    sharedPoolRows(db, { userId, windowDays: WIDE_CANDIDATE_WINDOW_DAYS, limit: SHARED_POOL_SCAN, exclude: own }),
    loadPoolBrief(db, userId),
  ]);
  const candidates = pool.map((r) => ({ ...r, sourceMode: null, minutes: r.readTimeMinutes, shared: true }));
  return own.length + sharedPoolMatches(candidates, brief, { now: new Date(), max: wanted }).length >= wanted;
}

/** Where an on-demand letter has got to (see `letterStages`). */
export async function letterProgress(db: Db, row: typeof letter.$inferSelect): Promise<LetterProgress> {
  let stage: LetterStage;
  switch (row.status) {
    case "sent":
    case "short_sent":
      stage = "sent";
      break;
    case "skipped_no_candidates":
    case "skipped":
      stage = "empty";
      break;
    case "failed":
      stage = "failed";
      break;
    case "scheduled": {
      if (!row.awaitingDiscovery) {
        stage = "writing";
        break;
      }
      const [run] = await db
        .select({ status: discoveryRun.status })
        .from(discoveryRun)
        .where(and(eq(discoveryRun.userId, row.userId), eq(discoveryRun.occurrenceId, row.occurrenceId)));
      stage = run && (run.status === "pending" || run.status === "running") ? "searching" : "reading";
      break;
    }
    default:
      stage = "writing";
  }
  return { id: row.id, stage, isTest: row.isTest };
}
