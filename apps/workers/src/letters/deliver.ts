import { schema } from "@fs/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import { STEP_LEASE_MINUTES } from "./state.ts";

const { letter } = schema;

/**
 * Delivery (§6.1 step 4). A `ready` letter whose time has come is claimed
 * (`ready → sending`), handed to the delivery seam, then marked `sent` (or
 * `short_sent`) with its number. Email and push arrive in M5: they'll queue a
 * `deliver` message per channel here and claim a `delivery_attempt` row per
 * channel, so retries never send twice. Until then the app finds the letter
 * through /letters/today.
 */
export async function deliverLetter(deps: PipelineDeps, letterId: string) {
  const { db } = deps;
  const [claimed] = await db
    .update(letter)
    .set({ status: "sending", watchdogAt: sql`now() + make_interval(mins => ${STEP_LEASE_MINUTES})` })
    .where(and(eq(letter.id, letterId), eq(letter.status, "ready"), lte(letter.scheduledFor, sql`now()`)))
    .returning({ id: letter.id, userId: letter.userId, short: letter.short });
  if (!claimed) return false;

  // TODO(M5): queue email and push for each of the schedule's channels.

  return markSent(deps, claimed);
}

/** `sending → sent`, numbering the letter among the user's delivered letters. Safe to re-run. */
export async function markSent(deps: PipelineDeps, l: { id: string; userId: string; short: boolean }) {
  const delivered = await deps.db.transaction(async (tx) => {
    // Numbers are per user; serialize this user's deliveries so two can't take the same one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`letter-number:${l.userId}`}))`);
    const [row] = await tx
      .update(letter)
      .set({
        status: l.short ? "short_sent" : "sent",
        deliveredAt: sql`now()`,
        watchdogAt: null,
        number: sql`(select coalesce(max(number), 0) + 1 from ${letter} where user_id = ${l.userId})`,
      })
      .where(and(eq(letter.id, l.id), eq(letter.status, "sending")))
      .returning({ number: letter.number });
    return row ?? null;
  });
  if (delivered) logger(deps)("letter_sent", { letterId: l.id, number: delivered.number });
  return !!delivered;
}
