import { schema } from "@fs/db";
import type { LetterWork } from "@fs/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { PipelineDeps } from "../pipeline/deps.ts";
import type { letterStepStatuses } from "../pipeline/messages.ts";

const { letter } = schema;

/**
 * The letter pipeline's state machine (build plan §6.2). The status column is
 * the state; every step is claimed with a compare-and-set on it, so a
 * duplicate or stale message does nothing:
 *
 *   scheduled → collecting → ranking → generating → verifying → ready → sending → sent | short_sent
 *   terminal: skipped_no_candidates, failed (and `skipped` for "skip next")
 *
 * A `letter-step` message `{ letterId, expectedStatus }` runs the step after
 * `expectedStatus`. The claim moves the letter into that step's status. When
 * the step finishes it writes its output to `work` (status unchanged) and
 * queues `{ expectedStatus: <its status> }` for the next step. If it throws,
 * the claim is undone so the queue's retry can claim it again. A crash that
 * skips both (a Lambda timeout) is found by the watchdog.
 */

export type ExpectedStatus = (typeof letterStepStatuses)[number];
export type RunningStatus = "collecting" | "ranking" | "generating" | "verifying";

export const NEXT_STATUS: Record<ExpectedStatus, RunningStatus> = {
  scheduled: "collecting",
  collecting: "ranking",
  ranking: "generating",
  generating: "verifying",
};
export const PREVIOUS_STATUS: Record<RunningStatus, ExpectedStatus> = {
  collecting: "scheduled",
  ranking: "collecting",
  generating: "ranking",
  verifying: "generating",
};

/** How long a step may run before the watchdog steps in (Lambda's timeout is 5 minutes). */
export const STEP_LEASE_MINUTES = 10;
/** Claims per step before the letter is marked failed. */
export const MAX_STEP_ATTEMPTS = 3;

export type Letter = typeof letter.$inferSelect;

/** Whether a running step already wrote its output (so the watchdog moves on rather than re-running it). */
export function stepOutputWritten(status: RunningStatus, work: LetterWork): boolean {
  switch (status) {
    case "collecting":
      return work.candidates !== undefined;
    case "ranking":
      return work.ranked !== undefined;
    case "generating":
      return work.drafts !== undefined;
    case "verifying":
      // Lock moves the letter to `ready` in the same transaction as its output.
      return false;
  }
}

const lease = sql`now() + make_interval(mins => ${STEP_LEASE_MINUTES})`;

/** CAS `expected → running`, counting the attempt. Null when the message is stale or a duplicate. */
export async function claimStep(deps: PipelineDeps, letterId: string, expected: ExpectedStatus): Promise<Letter | null> {
  const running = NEXT_STATUS[expected];
  const [row] = await deps.db
    .update(letter)
    .set({
      status: running,
      stepAttempts: sql`jsonb_set(${letter.stepAttempts}, ${`{${running}}`}::text[], to_jsonb(coalesce((${letter.stepAttempts}->>${running})::int, 0) + 1))`,
      watchdogAt: lease,
    })
    .where(and(eq(letter.id, letterId), eq(letter.status, expected)))
    .returning();
  return row ?? null;
}

/** Undo a claim after a failure, so the retried message can claim it again. */
export async function releaseStep(deps: PipelineDeps, letterId: string, running: RunningStatus) {
  await deps.db
    .update(letter)
    .set({ status: PREVIOUS_STATUS[running], watchdogAt: lease })
    .where(and(eq(letter.id, letterId), eq(letter.status, running)));
}

/** Writes a step's output and queues the next step. False if the letter moved on meanwhile. */
export async function completeStep(deps: PipelineDeps, current: Letter, running: Exclude<RunningStatus, "verifying">, patch: LetterWork) {
  const [row] = await deps.db
    .update(letter)
    .set({ work: { ...current.work, ...patch }, watchdogAt: lease })
    .where(and(eq(letter.id, current.id), eq(letter.status, running)))
    .returning({ id: letter.id });
  if (!row) return false;
  await deps.queues.send("letter-step", { letterId: current.id, expectedStatus: running });
  return true;
}

/** Ends the pipeline early in a terminal status. */
export async function finishLetter(
  deps: PipelineDeps,
  letterId: string,
  from: RunningStatus,
  status: "skipped_no_candidates" | "failed",
  reason: string,
) {
  const [row] = await deps.db
    .update(letter)
    .set({ status, failureReason: reason, watchdogAt: null })
    .where(and(eq(letter.id, letterId), eq(letter.status, from)))
    .returning({ id: letter.id });
  return !!row;
}
