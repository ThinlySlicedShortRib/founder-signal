import { createHash } from "node:crypto";
import { authorKeyFor, cleanAuthorName, decideItemAccess, readTimeMinutes, resolveRights } from "@fs/core";
import { loadRightsRules, newsletterSourceKey, schema, upsertNewsletterSource } from "@fs/db";
import type { InboundConfirmation, InboundVerdicts } from "@fs/db/schema";
import {
  cleanSubject,
  detectForwardingConfirmation,
  findWebVersionUrl,
  inboundLocalPartOf,
  InboundEmailError,
  type MailVerdicts,
  NEAR_DUPLICATE_DISTANCE,
  newsletterSender,
  newsletterToArticle,
  type ParsedEmail,
  parseInboundEmail,
  type RawMailStore,
  syntheticNewsletterUrl,
  unwrapManualForward,
} from "@fs/ingest";
import { MAX_INBOUND_EMAIL_BYTES } from "@fs/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { contentKeys } from "../lib/content-store.ts";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";

const { contentItem, contentVersion, inboundAddress, inboundMessage, publisher } = schema;

/** Newsletter forwarding's settings: the inbound domain and where raw mail waits. */
export interface InboundDeps {
  domain: string;
  mail: RawMailStore;
}

/** Per address: more than this many messages an hour (or a day) are refused, so a loop or a flood can't fill a pool. */
export const INBOUND_PER_HOUR = 30;
export const INBOUND_PER_DAY = 200;
/** A claim older than this is assumed dead (the worker crashed) and can be taken again. */
const CLAIM_TTL_SECONDS = 300;

/** A message SES (or the dev route, or the CLI) delivered: where the raw MIME is, and what's known about it. */
export interface InboundDelivery {
  rawKey: string;
  /** SMTP RCPT TO addresses (SES's `receipt.recipients`); the headers are used when unknown. */
  envelopeTo?: string[] | null;
  /** SES's verdicts from its notification; they win over anything in the headers. */
  verdicts?: MailVerdicts;
  receivedAt?: Date;
}

export type InboundOutcome =
  | { status: "skipped" }
  | { status: "newsletter"; itemId: string; sourceId: string; reason: string | null }
  | { status: "confirmation"; confirmation: InboundConfirmation }
  | { status: "rejected" | "failed"; reason: string };

type Row = typeof inboundMessage.$inferSelect;

/** Records a delivery (once per raw key: a redelivered notification is a no-op) and processes it. */
export async function receiveInbound(deps: PipelineDeps, delivery: InboundDelivery): Promise<InboundOutcome> {
  await deps.db
    .insert(inboundMessage)
    .values({
      rawKey: delivery.rawKey,
      envelopeTo: delivery.envelopeTo?.length ? delivery.envelopeTo.map((a) => a.toLowerCase()) : null,
      verdicts: delivery.verdicts && Object.keys(delivery.verdicts).length ? delivery.verdicts : null,
      receivedAt: delivery.receivedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: inboundMessage.rawKey });
  return processInbound(deps, delivery.rawKey);
}

/**
 * Turns one stored message into what it is (docs/imports/README.md,
 * "Newsletters by email"): a newsletter item for the address's owner, a
 * forwarding confirmation to show them, or a refusal with its reason. Only
 * acts on a pending message it manages to claim, so concurrent deliveries
 * process it once. The raw MIME is deleted once the message is settled.
 * Unexpected errors release the claim and are rethrown (SQS retries); with
 * `failOnError` (the local runner) the message is marked failed instead.
 */
export async function processInbound(deps: PipelineDeps, rawKey: string, { failOnError = false } = {}): Promise<InboundOutcome> {
  const { db } = deps;
  if (!deps.inbound) throw new Error("Newsletter forwarding isn't configured (no inbound domain)");
  const [row] = await db
    .update(inboundMessage)
    .set({ claimedAt: sql`now()` })
    .where(
      and(
        eq(inboundMessage.rawKey, rawKey),
        eq(inboundMessage.status, "pending"),
        sql`(${inboundMessage.claimedAt} is null or ${inboundMessage.claimedAt} < now() - make_interval(secs => ${CLAIM_TTL_SECONDS}))`,
      ),
    )
    .returning();
  if (!row) return { status: "skipped" };

  try {
    const outcome = await handle(deps, deps.inbound, row);
    logger(deps)("newsletter_inbound", { messageId: row.id, status: outcome.status, reason: "reason" in outcome ? outcome.reason : null });
    return outcome;
  } catch (err) {
    if (!failOnError) {
      await db.update(inboundMessage).set({ claimedAt: null }).where(eq(inboundMessage.id, row.id));
      throw err;
    }
    await settle(deps, row, { status: "failed", reason: `error: ${(err as Error).message}`.slice(0, 300) }, { deleteRaw: false });
    return { status: "failed", reason: (err as Error).message };
  }
}

async function handle(deps: PipelineDeps, inbound: InboundDeps, row: Row): Promise<InboundOutcome> {
  const known = (row.verdicts ?? {}) as InboundVerdicts;
  if (known.virus === "FAIL") return reject(deps, row, "virus");

  const raw = await inbound.mail.get(row.rawKey, { maxBytes: MAX_INBOUND_EMAIL_BYTES });
  if (raw === null) return settle(deps, row, { status: "failed", reason: "raw_missing" }, { deleteRaw: false });
  if (raw === "tooLarge") return reject(deps, row, "too_large");

  let email: ParsedEmail;
  try {
    email = await parseInboundEmail(raw, { maxBytes: MAX_INBOUND_EMAIL_BYTES });
  } catch (err) {
    if (!(err instanceof InboundEmailError)) throw err;
    return err.reason === "too_large" ? reject(deps, row, "too_large") : settle(deps, row, { status: "failed", reason: "malformed" });
  }
  // SES's own verdicts (from its notification) beat the headers.
  const verdicts: InboundVerdicts = { ...email.headerVerdicts, ...known };
  const facts = {
    verdicts: Object.keys(verdicts).length ? verdicts : null,
    spam: verdicts.spam === "FAIL",
    fromAddress: email.from?.address ?? null,
    subject: email.subject?.slice(0, 300) ?? null,
    messageIdHash: email.messageId ? createHash("sha256").update(email.messageId).digest("hex") : null,
  };
  if (verdicts.virus === "FAIL") return reject(deps, row, "virus", facts);

  // ── Whose is it? ───────────────────────────────────────────────────────
  const recipients = row.envelopeTo?.length ? row.envelopeTo : email.recipients;
  const localParts = [...new Set(recipients.map((r) => inboundLocalPartOf(r, inbound.domain)).filter((l): l is string => !!l))];
  const addresses = localParts.length ? await deps.db.select().from(inboundAddress).where(inArray(inboundAddress.localPart, localParts)) : [];
  const address = addresses.find((a) => a.active) ?? addresses[0];
  if (!address) return reject(deps, row, "unknown_recipient", facts);
  const owner = { ...facts, addressId: address.id, userId: address.userId };
  if (!address.active) return reject(deps, row, "inactive_address", owner);

  const [recent] = await deps.db.execute<{ hour: number; day: number }>(sql`
    select count(*) filter (where received_at > now() - interval '1 hour')::int as hour, count(*)::int as day
    from ${inboundMessage} where address_id = ${address.id} and id <> ${row.id} and received_at > now() - interval '1 day'`).then((r) => r.rows);
  if ((recent?.hour ?? 0) >= INBOUND_PER_HOUR || (recent?.day ?? 0) >= INBOUND_PER_DAY) return reject(deps, row, "rate_limited", owner);

  // ── A forwarding confirmation? Shown to the user, never a newsletter. ───
  const confirmation = detectForwardingConfirmation(email, verdicts);
  if (confirmation) return settle(deps, row, { ...owner, status: "confirmation", confirmation }, {}, { status: "confirmation", confirmation });

  // ── The newsletter: unwrap a manual forward, then its content. ─────────
  const forward = unwrapManualForward(email);
  const message = forward
    ? { from: forward.from, subject: forward.subject ?? email.subject, date: forward.date ?? email.date, html: forward.html, text: forward.text ?? email.text, listId: null, listPost: null }
    : { from: email.from, subject: email.subject, date: email.date, html: email.html, text: email.text, listId: email.listId, listPost: email.listPost };
  if (!message.from) return reject(deps, row, "no_sender", owner);
  const title = cleanSubject(message.subject);
  const article = newsletterToArticle({ html: message.html, text: message.text, title });
  if (article.tooShort) return reject(deps, row, "no_content", owner);

  const webUrl = findWebVersionUrl({ html: message.html, text: message.text, listPost: message.listPost, title });
  const sender = newsletterSender({ from: message.from, listId: message.listId, webUrl });
  const src = await upsertNewsletterSource(deps.db, {
    userId: address.userId,
    importId: address.importId,
    sender,
    receivedAt: row.receivedAt,
  });
  if (!src.following) return reject(deps, row, "not_following", { ...owner, sourceId: src.sourceId });
  const linked = { ...owner, status: "newsletter" as const, sourceId: src.sourceId };

  // ── The same piece already here (its RSS item, or this email forwarded twice)? Link to it. ──
  const synthetic = syntheticNewsletterUrl({ messageId: email.messageId, from: message.from.address, subject: title, date: message.date, text: article.text });
  for (const [url, reason] of [[webUrl, "same_url"], [synthetic, "same_message"]] as const) {
    if (!url) continue;
    const existing = await usableItem(deps, url);
    if (existing) return settle(deps, row, { ...linked, itemId: existing, reason }, {}, { status: "newsletter", itemId: existing, sourceId: src.sourceId, reason });
  }
  if (article.simhash !== null) {
    const [dupe] = await deps.db
      .select({ id: contentItem.id })
      .from(contentItem)
      .where(
        and(
          sql`${contentItem.simhash} is not null`,
          sql`${contentItem.duplicateOfId} is null`,
          inArray(contentItem.status, ["extracted", "enriched"]),
          sql`bit_count(int8send(${contentItem.simhash} # ${article.simhash})) <= ${NEAR_DUPLICATE_DISTANCE}`,
        ),
      )
      .limit(1);
    if (dupe) return settle(deps, row, { ...linked, itemId: dupe.id, reason: "near_duplicate" }, {}, { status: "newsletter", itemId: dupe.id, sourceId: src.sourceId, reason: "near_duplicate" });
  }

  // ── A new item: already extracted, so it goes straight to enrichment. ──
  // The web URL when it's free; when another item holds it but isn't readable (pending, paywalled), our own key.
  let canonicalUrl = webUrl ?? synthetic;
  if (webUrl) {
    const [taken] = await deps.db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.canonicalUrl, webUrl));
    if (taken) canonicalUrl = synthetic;
  }
  const [pub] = await deps.db.select({ key: publisher.key, name: publisher.name }).from(publisher).where(eq(publisher.id, src.publisherId));
  const sourceKey = newsletterSourceKey(address.userId, sender.key);
  const rights = resolveRights(await loadRightsRules(deps.db, { publisherKeys: [pub!.key], sourceKeys: [sourceKey] }), { publisherKey: pub!.key, sourceKey });
  const access = decideItemAccess(rights, { unavailableReason: null });
  const itemId = crypto.randomUUID();
  const blocksKey = access.storeBlocks ? contentKeys.blocks(itemId, article.contentHash) : null;
  if (blocksKey) await deps.store.putJson(blocksKey, { blocks: article.blocks, sections: article.sections });

  const authorName = cleanAuthorName(sender.author, pub!.name) ?? cleanAuthorName(message.from.name, pub!.name);
  const created = await deps.db.transaction(async (tx) => {
    const [item] = await tx
      .insert(contentItem)
      .values({
        id: itemId,
        canonicalUrl,
        type: "article",
        sourceId: src.sourceId,
        publisherId: src.publisherId,
        title: title ?? sender.title,
        creator: sender.author ?? message.from!.name,
        authorName,
        authorKey: authorName ? authorKeyFor({ name: authorName, publisherKey: pub!.key }) : null,
        leadImageUrl: article.leadImageUrl,
        publishedAt: message.date ?? row.receivedAt,
        status: "extracted",
        wordCount: article.wordCount,
        readTimeMinutes: readTimeMinutes(article.wordCount),
        simhash: article.simhash,
      })
      .onConflictDoNothing({ target: contentItem.canonicalUrl })
      .returning({ id: contentItem.id });
    if (!item) return null;
    await tx.insert(contentVersion).values({
      itemId,
      contentHash: article.contentHash,
      blocksKey,
      sectionMap: article.sections,
      rightsSnapshot: { ...rights, ...access },
      excerpt: article.excerpt,
    });
    await tx
      .update(publisher)
      .set({ itemsSeen: sql`${publisher.itemsSeen} + 1`, extractionsOk: sql`${publisher.extractionsOk} + 1` })
      .where(eq(publisher.id, src.publisherId));
    return item.id;
  });
  // Lost a race for the same URL: link to the winner.
  const finalId = created ?? (await usableItem(deps, canonicalUrl)) ?? null;
  if (!finalId) return settle(deps, row, { ...owner, status: "failed", reason: "url_conflict", sourceId: src.sourceId });
  return settle(deps, row, { ...linked, itemId: finalId, reason: created ? null : "same_url" }, {}, { status: "newsletter", itemId: finalId, sourceId: src.sourceId, reason: created ? null : "same_url" });
}

/** The readable item at this URL (following a duplicate to its original), if any. */
async function usableItem(deps: PipelineDeps, canonicalUrl: string): Promise<string | null> {
  const [found] = await deps.db
    .select({ id: contentItem.id, duplicateOfId: contentItem.duplicateOfId, status: contentItem.status })
    .from(contentItem)
    .where(eq(contentItem.canonicalUrl, canonicalUrl));
  if (!found) return null;
  const id = found.duplicateOfId ?? found.id;
  if (!found.duplicateOfId) return found.status === "extracted" || found.status === "enriched" ? id : null;
  const [original] = await deps.db.select({ status: contentItem.status }).from(contentItem).where(and(eq(contentItem.id, id), ne(contentItem.status, "failed")));
  return original && (original.status === "extracted" || original.status === "enriched") ? id : null;
}

type Settled = Partial<Omit<Row, "id" | "rawKey">> & { status: Row["status"] };

function reject(deps: PipelineDeps, row: Row, reason: string, extra: Partial<Row> = {}) {
  return settle(deps, row, { ...extra, status: "rejected", reason });
}

/** Records the outcome, releases the claim and (normally) deletes the raw message. */
async function settle(deps: PipelineDeps, row: Row, patch: Settled, { deleteRaw = true } = {}, outcome?: InboundOutcome): Promise<InboundOutcome> {
  await deps.db
    .update(inboundMessage)
    .set({ ...patch, claimedAt: null, processedAt: sql`now()` })
    .where(eq(inboundMessage.id, row.id));
  if (deleteRaw) await deps.inbound!.mail.delete(row.rawKey);
  return outcome ?? (patch.status === "rejected" || patch.status === "failed" ? { status: patch.status, reason: patch.reason ?? "unknown" } : { status: "skipped" });
}

/** Messages the dev route stored, processed by the local runner (oldest first). */
export async function processPendingInbound(deps: PipelineDeps, { limit = 20 } = {}) {
  if (!deps.inbound) return 0;
  const pending = await deps.db
    .select({ rawKey: inboundMessage.rawKey })
    .from(inboundMessage)
    .where(
      and(
        eq(inboundMessage.status, "pending"),
        sql`(${inboundMessage.claimedAt} is null or ${inboundMessage.claimedAt} < now() - make_interval(secs => ${CLAIM_TTL_SECONDS}))`,
      ),
    )
    .orderBy(inboundMessage.receivedAt)
    .limit(limit);
  for (const { rawKey } of pending) await processInbound(deps, rawKey, { failOnError: true });
  return pending.length;
}
