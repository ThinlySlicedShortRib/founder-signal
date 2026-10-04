import { HELD_LETTER_EXTRACTION_WAIT_MINUTES } from "@fs/core";
import { schema } from "@fs/db";
import { sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import { STEP_LEASE_MINUTES } from "./state.ts";

const { contentItem, discoveryQuery, discoveryRun, letter, userDiscovery } = schema;

/**
 * Letters held for discovery (§6.3a): the first letter, and a test letter
 * when there's little to pick from. The API creates the letter `scheduled`
 * with `awaiting_discovery` set, a `discovery_run` with the same occurrence
 * ID, and a watchdog time HELD_LETTER_MAX_MINUTES ahead. The letter starts
 * once the run has ended (done or failed) and the pages it linked have been
 * extracted (or failed), waiting at most HELD_LETTER_EXTRACTION_WAIT_MINUTES
 * for those. That's checked when a run ends, when an item is extracted and on
 * every sweep. If none of that happens in time, the watchdog starts it anyway
 * (letters/sweep.ts).
 */

/**
 * Queues the pending runs that held letters wait on. On AWS the API queued
 * them already, so this only repeats a lost message (a duplicate finds the
 * run claimed and does nothing). Locally the API can't reach the dev runner's
 * queues, so this is how they start. With discovery off, they're marked
 * failed so their letters go ahead (call `releaseHeldLetters` after).
 */
export async function startHeldDiscovery(deps: PipelineDeps): Promise<number> {
  const { db } = deps;
  const pending = await db.execute<{ id: string }>(sql`
    select r.id from ${discoveryRun} r
    join ${letter} l on l.user_id = r.user_id and l.occurrence_id = r.occurrence_id
    where l.awaiting_discovery and l.status = 'scheduled' and r.status = 'pending'`);
  if (!pending.rows.length) return 0;
  if (!deps.discovery) {
    // The sweep releases their letters next.
    for (const { id } of pending.rows) await failHeldRun(deps, id, "discovery is off");
    return 0;
  }
  for (const { id } of pending.rows) await deps.queues.send("discover", { runId: id });
  return pending.rows.length;
}

/** Whether a held letter is waiting on this run, so it gets one attempt rather than queue retries. */
export async function runHoldsLetter(deps: PipelineDeps, runId: string): Promise<boolean> {
  const held = await deps.db.execute<{ one: number }>(sql`
    select 1 as one from ${discoveryRun} r
    join ${letter} l on l.user_id = r.user_id and l.occurrence_id = r.occurrence_id
    where r.id = ${runId} and l.awaiting_discovery and l.status = 'scheduled'`);
  return held.rows.length > 0;
}

export async function failHeldRun(deps: PipelineDeps, runId: string, error: string) {
  await deps.db.execute(sql`
    update ${discoveryRun} set status = 'failed', error = ${error.slice(0, 500)}, finished_at = now(), updated_at = now()
    where id = ${runId} and status in ('pending', 'running')`);
  logger(deps)("held_discovery_failed", { runId, error });
}

/** Starts every held letter whose run has ended and whose found pages are extracted (or waited for long enough). */
export async function releaseHeldLetters(deps: PipelineDeps): Promise<number> {
  const released = await deps.db.execute<{ id: string }>(sql`
    update ${letter} set awaiting_discovery = false, watchdog_at = now() + make_interval(mins => ${STEP_LEASE_MINUTES}), updated_at = now()
    where awaiting_discovery and id in (
      select l.id from ${letter} l
      left join ${discoveryRun} r on r.user_id = l.user_id and r.occurrence_id = l.occurrence_id
      where l.awaiting_discovery and l.status = 'scheduled'
        and (r.id is null or (r.status in ('done', 'failed') and (
          r.finished_at is null
          or r.finished_at <= now() - make_interval(mins => ${HELD_LETTER_EXTRACTION_WAIT_MINUTES})
          or not exists (
            select 1 from ${discoveryQuery} q
            join ${userDiscovery} ud on ud.query_id = q.id
            join ${contentItem} ci on ci.id = ud.item_id
            where q.run_id = r.id and ci.status = 'pending'))))
      for update of l skip locked)
    returning id`);
  for (const { id } of released.rows) await deps.queues.send("letter-step", { letterId: id, expectedStatus: "scheduled" });
  if (released.rows.length) logger(deps)("held_letters_released", { count: released.rows.length });
  return released.rows.length;
}
