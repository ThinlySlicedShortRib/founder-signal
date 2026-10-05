import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { sourceImport } from "../schema/imports.ts";
import { publisher, source, userSource } from "../schema/ingestion.ts";
import { inboundAddress } from "../schema/newsletters.ts";

/**
 * Newsletter forwarding (docs/imports/README.md, "Newsletters by email"):
 * the user's inbound address and the per-sender `newsletter` sources.
 */

export type InboundAddressRow = typeof inboundAddress.$inferSelect;

/**
 * The user's active inbound address, made on first use. A new address also
 * gets the `source_import` its newsletter sources point back to. Safe to
 * call concurrently: one active address per user is enforced by a unique
 * index, and the loser of a race reads the winner's row.
 */
export async function getOrCreateInboundAddress(db: Db, userId: string, newLocalPart: () => string): Promise<InboundAddressRow> {
  const [existing] = await db.select().from(inboundAddress).where(and(eq(inboundAddress.userId, userId), eq(inboundAddress.active, true)));
  if (existing) return existing;
  try {
    return await createAddress(db, userId, newLocalPart);
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code !== "23505") throw err;
    const [winner] = await db.select().from(inboundAddress).where(and(eq(inboundAddress.userId, userId), eq(inboundAddress.active, true)));
    if (!winner) throw err;
    return winner;
  }
}

/** Deactivates the user's address (mail to it is refused from now on) and makes a new one. Newsletter sources stay. */
export async function rotateInboundAddress(db: Db, userId: string, newLocalPart: () => string): Promise<InboundAddressRow> {
  return db.transaction(async (tx) => {
    const [old] = await tx
      .update(inboundAddress)
      .set({ active: false, rotatedAt: sql`now()` })
      .where(and(eq(inboundAddress.userId, userId), eq(inboundAddress.active, true)))
      .returning();
    const [row] = await tx
      .insert(inboundAddress)
      .values({ userId, localPart: newLocalPart(), importId: old?.importId ?? (await newImport(tx, userId)) })
      .returning();
    return row!;
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function createAddress(db: Db, userId: string, newLocalPart: () => string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(inboundAddress).values({ userId, localPart: newLocalPart(), importId: await newImport(tx, userId) }).returning();
    return row!;
  });
}

/** The import record newsletter sources point back to (`user_source.import_id`). It has no checklist: senders are added as their mail arrives. */
async function newImport(tx: Tx, userId: string): Promise<string> {
  const [row] = await tx
    .insert(sourceImport)
    .values({ userId, method: "newsletter", label: "Newsletters by email", candidates: [], foundCount: 0, confirmedAt: sql`now()` })
    .returning({ id: sourceImport.id });
  return row!.id;
}

export interface NewsletterSourceInput {
  userId: string;
  importId: string | null;
  /** From @fs/ingest `newsletterSender`. */
  sender: { key: string; label: string; title: string; author: string | null; publisher: { key: string; name: string } };
  receivedAt: Date;
}

/** The canonical key of a user's newsletter source: per user, because what arrives by email is their own copy. */
export function newsletterSourceKey(userId: string, senderKey: string): string {
  return `newsletter:${userId}:${senderKey}`;
}

/**
 * Upserts the sender's publisher (shared, keyed like its website) and the
 * user's `newsletter` source, and follows it. Never polled (no next fetch);
 * `last_fetched_at` is when its latest email arrived. A source the user
 * stopped following stays stopped: `following` is false and the caller
 * ignores the email.
 */
export async function upsertNewsletterSource(db: Db, input: NewsletterSourceInput): Promise<{ sourceId: string; publisherId: string; following: boolean }> {
  return db.transaction(async (tx) => {
    const [pub] = await tx
      .insert(publisher)
      .values({ key: input.sender.publisher.key, name: input.sender.publisher.name, origin: "user_added" })
      // Keep the name we have (a site's own name beats a sender's display name).
      .onConflictDoUpdate({ target: publisher.key, set: { key: sql`excluded.key` } })
      .returning({ id: publisher.id });

    const mailto = `mailto:${input.sender.label}`;
    const [src] = await tx
      .insert(source)
      .values({
        canonicalKey: newsletterSourceKey(input.userId, input.sender.key),
        type: "newsletter",
        publisherId: pub!.id,
        title: input.sender.title,
        creator: input.sender.author,
        inputUrl: mailto,
        fetchUrl: mailto,
        nextFetchAt: null,
        lastFetchedAt: input.receivedAt,
        lastFetchStatus: "ok",
      })
      .onConflictDoUpdate({
        target: source.canonicalKey,
        set: { lastFetchedAt: sql`greatest(${source.lastFetchedAt}, excluded.last_fetched_at)`, lastFetchStatus: "ok" },
      })
      .returning({ id: source.id });

    const inserted = await tx
      .insert(userSource)
      .values({ userId: input.userId, sourceId: src!.id, importId: input.importId })
      .onConflictDoNothing({ target: [userSource.userId, userSource.sourceId] })
      .returning({ id: userSource.id });
    if (inserted.length && input.importId) {
      await tx
        .update(sourceImport)
        .set({ addedCount: sql`${sourceImport.addedCount} + 1`, foundCount: sql`${sourceImport.foundCount} + 1` })
        .where(eq(sourceImport.id, input.importId));
    }
    const [link] = await tx
      .select({ blocked: userSource.blocked })
      .from(userSource)
      .where(and(eq(userSource.userId, input.userId), eq(userSource.sourceId, src!.id)));
    return { sourceId: src!.id, publisherId: pub!.id, following: !link?.blocked };
  });
}
