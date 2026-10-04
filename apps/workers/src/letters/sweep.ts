import { localDateOf, nextRunAt } from "@fs/core";
import { schema } from "@fs/db";
import type { LetterWork } from "@fs/db/schema";
import { sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import { deliverLetter, markSent } from "./deliver.ts";
import { releaseHeldLetters, startHeldDiscovery } from "./held.ts";
import { type ExpectedStatus, MAX_STEP_ATTEMPTS, PREVIOUS_STATUS, type RunningStatus, STEP_LEASE_MINUTES, stepOutputWritten } from "./state.ts";

const { letter, schedule } = schema;

/** Letters are assembled this long before they're due (§6.1). */
export const ASSEMBLY_LEAD_MINUTES = 45;
/** A run missed by more than this (the sweep was off) is skipped rather than sent late. */
const MISSED_AFTER_HOURS = 6;
const MAX_PER_SWEEP = 100;

/**
 * The letter part of the 5-minute sweep (§6.1):
 * - due schedules become occurrences (one letter per occurrence, ever);
 * - letters held for discovery (letters/held.ts): their runs are started,
 *   and the ones ready to go are released;
 * - the watchdog re-queues letters stuck in a step, and starts held letters
 *   that waited too long;
 * - ready letters whose time has come are delivered.
 * Overlapping sweeps are safe: rows are claimed with SKIP LOCKED, and the
 * occurrence insert is `ON CONFLICT DO NOTHING`.
 */
export async function sweepLetters(deps: PipelineDeps) {
  const occurrences = await claimDueSchedules(deps);
  await startHeldDiscovery(deps);
  const released = await releaseHeldLetters(deps);
  const watchdog = await runWatchdog(deps);
  const delivered = await deliverDue(deps);
  return {
    lettersScheduled: occurrences,
    lettersReleased: released + watchdog.released,
    lettersRequeued: watchdog.requeued,
    lettersFailed: watchdog.failed,
    lettersDelivered: delivered,
  };
}

async function claimDueSchedules(deps: PipelineDeps): Promise<number> {
  const { db } = deps;
  const log = logger(deps);
  const now = deps.now?.() ?? new Date();

  const created = await db.transaction(async (tx) => {
    const due = await tx.execute<{
      user_id: string;
      next_run_at: Date;
      weekdays: number[];
      local_time: string;
      time_zone: string;
      version: number;
      skip_next: boolean;
    }>(sql`
      select user_id, next_run_at, weekdays, local_time, time_zone, version, skip_next from ${schedule}
      where next_run_at is not null and not paused
        and next_run_at - make_interval(mins => ${ASSEMBLY_LEAD_MINUTES}) <= ${now}
      order by next_run_at
      limit ${MAX_PER_SWEEP}
      for update skip locked`);

    const letters: string[] = [];
    for (const s of due.rows) {
      const runAt = new Date(s.next_run_at);
      const rule = { weekdays: s.weekdays, localTime: s.local_time, timeZone: s.time_zone };
      const missed = now.getTime() - runAt.getTime() > MISSED_AFTER_HOURS * 3_600_000;
      if (!missed) {
        const occurrenceId = `${localDateOf(runAt, s.time_zone)}#${s.version}`;
        // The duplicate-delivery guard: a retried or overlapping sweep inserts nothing.
        const inserted = await tx.execute<{ id: string }>(sql`
          insert into ${letter} (user_id, occurrence_id, status, scheduled_for, local_date, watchdog_at)
          values (${s.user_id}, ${occurrenceId}, ${s.skip_next ? "skipped" : "scheduled"}, ${runAt}, ${localDateOf(runAt, s.time_zone)},
                  ${s.skip_next ? null : sql`now() + make_interval(mins => ${STEP_LEASE_MINUTES})`})
          on conflict (user_id, occurrence_id) do nothing
          returning id`);
        if (inserted.rows[0] && !s.skip_next) letters.push(inserted.rows[0].id);
      }
      // Next run strictly after this one (or after now, if this one was missed), in the user's zone.
      const next = nextRunAt(rule, missed ? now : runAt);
      await tx.execute(sql`
        update ${schedule} set next_run_at = ${next}, skip_next = case when ${missed} then skip_next else false end, updated_at = now()
        where user_id = ${s.user_id}`);
    }
    return letters;
  });

  // Only a newly inserted occurrence starts the pipeline. If this send is lost, the watchdog sends it.
  for (const letterId of created) await deps.queues.send("letter-step", { letterId, expectedStatus: "scheduled" });
  if (created.length) log("letters_scheduled", { count: created.length });
  return created.length;
}

/**
 * Letters whose watchdog time has passed without moving: a lost message, or a
 * step that died without releasing its claim (a Lambda timeout). A running
 * step whose output was written moves on; otherwise it's rolled back and run
 * again, until it runs out of attempts. A letter still held for discovery
 * past its watchdog time (the run is stuck) starts without waiting further.
 */
async function runWatchdog(deps: PipelineDeps): Promise<{ requeued: number; failed: number; released: number }> {
  const { db } = deps;
  const log = logger(deps);
  const now = deps.now?.() ?? new Date();
  const toSend: { letterId: string; expectedStatus: ExpectedStatus }[] = [];
  const toDeliver: { id: string; userId: string; short: boolean }[] = [];
  let failed = 0;
  let released = 0;

  await db.transaction(async (tx) => {
    const stuck = await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      work: LetterWork;
      step_attempts: Record<string, number>;
      short: boolean;
      awaiting_discovery: boolean;
    }>(sql`
      select id, user_id, status, work, step_attempts, short, awaiting_discovery from ${letter}
      where status in ('scheduled', 'collecting', 'ranking', 'generating', 'verifying', 'sending')
        and watchdog_at is not null and watchdog_at <= ${now}
      order by watchdog_at
      limit ${MAX_PER_SWEEP}
      for update skip locked`);

    for (const l of stuck.rows) {
      const bump = sql`now() + make_interval(mins => ${STEP_LEASE_MINUTES})`;
      if (l.status === "sending") {
        toDeliver.push({ id: l.id, userId: l.user_id, short: l.short });
        continue;
      }
      if (l.status === "scheduled") {
        await tx.execute(sql`update ${letter} set watchdog_at = ${bump}, awaiting_discovery = false where id = ${l.id}`);
        if (l.awaiting_discovery) released++;
        toSend.push({ letterId: l.id, expectedStatus: "scheduled" });
        continue;
      }
      const running = l.status as RunningStatus;
      if (stepOutputWritten(running, l.work)) {
        // The step finished but its next message was lost.
        await tx.execute(sql`update ${letter} set watchdog_at = ${bump} where id = ${l.id}`);
        toSend.push({ letterId: l.id, expectedStatus: running as ExpectedStatus });
      } else if ((l.step_attempts[running] ?? 0) >= MAX_STEP_ATTEMPTS) {
        await tx.execute(sql`update ${letter} set status = 'failed', failure_reason = ${`${running}: stuck`}, watchdog_at = null where id = ${l.id}`);
        failed++;
      } else {
        const previous = PREVIOUS_STATUS[running];
        await tx.execute(sql`update ${letter} set status = ${previous}, watchdog_at = ${bump} where id = ${l.id}`);
        toSend.push({ letterId: l.id, expectedStatus: previous });
      }
    }
  });

  for (const m of toSend) await deps.queues.send("letter-step", m);
  for (const l of toDeliver) await markSent(deps, l);
  if (toSend.length || failed) log("letter_watchdog", { requeued: toSend.length - released, failed, holdsExpired: released });
  return { requeued: toSend.length - released, failed, released };
}

async function deliverDue(deps: PipelineDeps): Promise<number> {
  const due = await deps.db.execute<{ id: string }>(sql`
    select id from ${letter} where status = 'ready' and scheduled_for <= now() order by scheduled_for limit ${MAX_PER_SWEEP}`);
  let delivered = 0;
  for (const { id } of due.rows) if (await deliverLetter(deps, id)) delivered++;
  return delivered;
}
