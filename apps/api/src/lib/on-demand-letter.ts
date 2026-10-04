import { CANDIDATE_WINDOW_DAYS, DISCOVERED_CANDIDATE_DAYS, HELD_LETTER_MAX_MINUTES, localDateOf } from "@fs/core";
import { type Db, schema } from "@fs/db";
import type { LetterProgress, LetterStage } from "@fs/schema";
import { and, eq, sql } from "drizzle-orm";
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
 * Whether there's already enough to make a letter from: at least the
 * schedule's item count of fresh, extracted pieces from followed sources or
 * recent discoveries that the user hasn't had or reviewed. A cheap version of
 * the collect step's rules (apps/workers/src/letters/steps.ts), used to decide
 * whether a test letter should search the web first.
 */
export async function hasEnoughToPick(db: Db, userId: string): Promise<boolean> {
  const [s] = await db.select({ itemCount: schedule.itemCount }).from(schedule).where(eq(schedule.userId, userId));
  const needed = s?.itemCount ?? 3;
  const found = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select ci.id from content_item ci
      join publisher p on p.id = ci.publisher_id
      where ci.status in ('extracted', 'enriched') and ci.duplicate_of_id is null and ci.title is not null
        and coalesce(ci.quality_label, 'substantive') not in ('thin', 'seo_filler') and p.status <> 'blocked'
        and (
          (coalesce(ci.published_at, ci.created_at) > now() - make_interval(days => ${CANDIDATE_WINDOW_DAYS})
            and exists (select 1 from user_source us where us.source_id = ci.source_id and us.user_id = ${userId} and not us.blocked))
          or exists (select 1 from user_discovery ud where ud.item_id = ci.id and ud.user_id = ${userId}
            and ud.found_at > now() - make_interval(days => ${DISCOVERED_CANDIDATE_DAYS})))
        and not exists (select 1 from letter_item li join letter l on l.id = li.letter_id where li.item_id = ci.id and l.user_id = ${userId})
        and not exists (select 1 from review r where r.item_id = ci.id and r.user_id = ${userId})
      limit ${needed}
    ) c`);
  return (found.rows[0]?.n ?? 0) >= needed;
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
