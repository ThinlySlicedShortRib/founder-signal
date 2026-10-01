import { schema } from "@fs/db";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "./deps.ts";

const { contentItem, enrichmentBatch, source, userSource } = schema;

/** How long a claimed source is hidden from other sweeps while its fetch runs. */
const FETCH_LEASE = "15 minutes";
const MAX_SOURCES_PER_SWEEP = 100;
/** Give batches a few minutes before polling; most finish well within the hour. */
const BATCH_POLL_MIN_AGE = "3 minutes";

/**
 * Runs every 5 minutes (EventBridge Scheduler). The M1 part of the sweep:
 * due sources → fetch-source, and enrichment batch submission and polling.
 * Overlapping sweeps are safe: sources are claimed with SKIP LOCKED and a lease.
 */
export async function sweep(deps: PipelineDeps) {
  const { db, queues } = deps;
  const log = logger(deps);

  // Only poll sources someone still follows.
  const followed = db
    .select({ one: sql`1` })
    .from(userSource)
    .where(and(eq(userSource.sourceId, source.id), eq(userSource.blocked, false)));

  const claimed = await db.execute<{ id: string }>(sql`
    update ${source} set next_fetch_at = now() + interval '${sql.raw(FETCH_LEASE)}'
    where id in (
      select id from ${source}
      where next_fetch_at <= now() and exists (${followed})
      order by next_fetch_at
      limit ${MAX_SOURCES_PER_SWEEP}
      for update skip locked
    )
    returning id`);
  for (const { id } of claimed.rows) await queues.send("fetch-source", { sourceId: id });

  let enrichSubmitted = false;
  let batchesPolled = 0;
  if (deps.enricher) {
    const [waiting] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItem)
      .where(and(eq(contentItem.status, "extracted"), isNull(contentItem.enrichmentBatchId), isNull(contentItem.duplicateOfId)));
    if (waiting && waiting.n > 0) {
      await queues.send("enrich", { kind: "submit" });
      enrichSubmitted = true;
    }

    const open = await db
      .select({ id: enrichmentBatch.id })
      .from(enrichmentBatch)
      .where(
        and(
          eq(enrichmentBatch.status, "submitted"),
          lte(enrichmentBatch.submittedAt, sql`now() - interval '${sql.raw(BATCH_POLL_MIN_AGE)}'`),
        ),
      );
    for (const { id } of open) await queues.send("enrich", { kind: "poll", batchId: id });
    batchesPolled = open.length;
  }

  log("sweep", { sourcesClaimed: claimed.rows.length, enrichSubmitted, batchesPolled });
  return { sourcesClaimed: claimed.rows.length, enrichSubmitted, batchesPolled };
}

