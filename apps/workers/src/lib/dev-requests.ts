import { schema } from "@fs/db";
import { DEV_RUN_PREFIX, TEST_LETTER_PREFIX } from "@fs/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { discover } from "../discovery/discover.ts";
import { processPendingInbound } from "../newsletters/receive.ts";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";

const { discoveryRun, letter } = schema;

/**
 * What the app's Dev tools screen asked for through the local API, which
 * can't reach the dev runner's in-memory queues (local development only):
 * - discovery runs it started (`dev#<id>`, pending, never queued) run here;
 * - a test letter waiting on one (`test#<same id>`, no watchdog time) is
 *   released once that run has ended, and the letter sweep starts it;
 * - followed sources it made due ask for a sweep now rather than at the next minute;
 * - newsletters posted to /dev/newsletters/inbound (there's no SES locally) are processed.
 */
export async function runDevRequests(deps: PipelineDeps): Promise<{ sweepNow: boolean }> {
  await processPendingInbound(deps);
  await releaseWaitingLetters(deps);
  await runRequestedDiscovery(deps);
  return { sweepNow: await followedSourceDue(deps) };
}

/** Held test letters whose discovery run is done or failed (or gone) get a watchdog time. */
async function releaseWaitingLetters(deps: PipelineDeps) {
  const released = await deps.db.execute<{ id: string }>(sql`
    update ${letter} l set watchdog_at = now(), updated_at = now()
    where l.status = 'scheduled' and l.watchdog_at is null and l.occurrence_id like ${`${TEST_LETTER_PREFIX}%`}
      and not exists (
        select 1 from ${discoveryRun} r
        where r.user_id = l.user_id and r.occurrence_id = ${DEV_RUN_PREFIX} || substr(l.occurrence_id, ${TEST_LETTER_PREFIX.length + 1})
          and r.status in ('pending', 'running'))
    returning l.id`);
  if (released.rows.length) logger(deps)("dev_letters_released", { count: released.rows.length });
}

/**
 * Runs pending `dev#` runs one at a time. A run that throws is marked failed
 * rather than retried, so a letter waiting on it isn't held forever.
 */
async function runRequestedDiscovery(deps: PipelineDeps) {
  const { db } = deps;
  const pending = await db
    .select({ id: discoveryRun.id })
    .from(discoveryRun)
    .where(and(eq(discoveryRun.status, "pending"), like(discoveryRun.occurrenceId, `${DEV_RUN_PREFIX}%`)))
    .orderBy(discoveryRun.createdAt);
  for (const { id } of pending) {
    if (!deps.discovery) {
      await failRun(deps, id, "Discovery is off (DISCOVERY=none)");
      continue;
    }
    try {
      await discover(deps, { runId: id });
    } catch (err) {
      await failRun(deps, id, (err as Error).message);
    }
  }
}

async function failRun(deps: PipelineDeps, runId: string, error: string) {
  await deps.db
    .update(discoveryRun)
    .set({ status: "failed", error: error.slice(0, 500), finishedAt: sql`now()` })
    .where(eq(discoveryRun.id, runId));
  logger(deps)("dev_discovery_failed", { runId, error });
}

/** A followed source is due: the sweep (which claims it) can run now. */
async function followedSourceDue(deps: PipelineDeps): Promise<boolean> {
  const due = await deps.db.execute<{ due: boolean }>(sql`
    select exists (
      select 1 from ${schema.source} s
      where s.next_fetch_at <= now()
        and exists (select 1 from ${schema.userSource} us where us.source_id = s.id and not us.blocked)
    ) as due`);
  return !!due.rows[0]?.due;
}
