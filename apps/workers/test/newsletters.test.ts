import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fallbackLetterWriter } from "@fs/ai";
import { addUserSource, createDb, getOrCreateInboundAddress, ownCandidateIds, rotateInboundAddress, schema, sharedPoolRows } from "@fs/db";
import { memoryRawMailStore, newInboundLocalPart } from "@fs/ingest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryContentStore } from "../src/lib/content-store.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import { INBOUND_PER_HOUR, processPendingInbound, receiveInbound } from "../src/newsletters/receive.ts";
import { deliveryFromSesMessage } from "../src/newsletters/ses.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";

const { contentItem, contentVersion, inboundMessage, publisher, source, sourceImport, user, userSource } = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

const DOMAIN = "in.test";
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "ingest", "test", "fixtures", "newsletters");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.eml`), "utf8");
const SUBSTACK_URL = "https://thebootstrappedoperator.substack.com/p/pricing-your-first-productized-service";
const WINDOW = { followedDays: 30, discoveredDays: 30 };

function createWorld() {
  const { store: mail, objects: mailObjects } = memoryRawMailStore();
  const { store, objects } = memoryContentStore();
  const deps: PipelineDeps = {
    db,
    queues: memoryQueues().queues,
    store,
    fetch: async () => {
      throw new Error("Newsletters never fetch");
    },
    youtube: null,
    transcripts: null,
    enricher: null,
    letterWriter: fallbackLetterWriter,
    authorEnricher: null,
    stockPhotos: null,
    images: null,
    discovery: null,
    inbound: { domain: DOMAIN, mail },
    log: () => {},
  };
  /** Stores a raw message as SES would and delivers it. */
  async function deliver(raw: string, { to, verdicts }: { to?: string[] | null; verdicts?: Record<string, string> } = {}) {
    const rawKey = `inbound/${randomUUID()}`;
    await mail.put(rawKey, new TextEncoder().encode(raw));
    const outcome = await receiveInbound(deps, { rawKey, envelopeTo: to, verdicts });
    return { rawKey, outcome };
  }
  return { deps, mail, mailObjects, objects, deliver };
}

async function newUser() {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "t", email: `${id}@example.com` });
  const address = await getOrCreateInboundAddress(db, id, () => newInboundLocalPart());
  return { id, address, email: `${address.localPart}@${DOMAIN}` };
}

async function messageRow(rawKey: string) {
  const [row] = await db.select().from(inboundMessage).where(eq(inboundMessage.rawKey, rawKey));
  return row!;
}

/** A unique copy of a fixture, so tests don't dedupe against each other. */
function variant(raw: string, n: string) {
  return raw.replace(/^Message-ID: <([^>]+)>/m, `Message-ID: <${n}-$1>`);
}

beforeEach(async () => {
  // Items from earlier tests would be near-duplicates of the same fixtures.
  await db.execute(sql`update content_item set simhash = null, canonical_url = canonical_url || '#' || id where canonical_url like '%thebootstrappedoperator%' or canonical_url like 'newsletter://%'`);
});

describe("newsletter inbound", () => {
  it("turns a forwarded Substack post into an extracted item of a per-user newsletter source", async () => {
    const w = createWorld();
    const sam = await newUser();
    const { rawKey, outcome } = await w.deliver(fixture("substack-post"), { to: [sam.email] });

    expect(outcome).toMatchObject({ status: "newsletter", reason: null });
    if (outcome.status !== "newsletter") throw new Error("unreachable");
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, outcome.itemId));
    expect(item).toMatchObject({
      canonicalUrl: SUBSTACK_URL,
      type: "article",
      status: "extracted",
      title: "Pricing your first productized service",
      sourceId: outcome.sourceId,
    });
    expect(item!.publishedAt?.toISOString()).toBe("2026-10-05T08:02:00.000Z");
    expect(item!.wordCount).toBeGreaterThan(300);

    const [src] = await db.select().from(source).where(eq(source.id, outcome.sourceId));
    expect(src).toMatchObject({ type: "newsletter", canonicalKey: `newsletter:${sam.id}:list:thebootstrappedoperator.substack.com`, title: "The Bootstrapped Operator", nextFetchAt: null, inputUrl: "mailto:thebootstrappedoperator@substack.com" });
    const [pub] = await db.select().from(publisher).where(eq(publisher.id, src!.publisherId));
    expect(pub!.key).toBe("thebootstrappedoperator.substack.com");
    const [link] = await db.select().from(userSource).where(and(eq(userSource.userId, sam.id), eq(userSource.sourceId, src!.id)));
    expect(link!.importId).toBe(sam.address.importId);
    const [imp] = await db.select().from(sourceImport).where(eq(sourceImport.id, sam.address.importId!));
    expect(imp).toMatchObject({ method: "newsletter", addedCount: 1 });

    // Blocks were stored (personal use: full text, retained) and nothing executable got in.
    const [version] = await db.select().from(contentVersion).where(eq(contentVersion.itemId, item!.id));
    expect(version!.blocksKey).toBeTruthy();
    const stored = w.objects.get(version!.blocksKey!)!;
    expect(stored).toContain("Write the promise before the price");
    expect(stored).not.toMatch(/Unsubscribe|eotrx|<script/i);

    // Recorded, raw deleted, and a letter candidate for this user.
    expect(await messageRow(rawKey)).toMatchObject({ status: "newsletter", userId: sam.id, fromAddress: "thebootstrappedoperator@substack.com", spam: false });
    expect(w.mailObjects.has(rawKey)).toBe(false);
    expect(await ownCandidateIds(db, { userId: sam.id, window: WINDOW, limit: 50 })).toContain(item!.id);
  });

  it("processes a redelivery once, and links the same message forwarded twice to its item", async () => {
    const w = createWorld();
    const sam = await newUser();
    const raw = variant(fixture("beehiiv-newsletter"), "twice");
    const first = await w.deliver(raw, { to: [sam.email] });
    expect(first.outcome).toMatchObject({ status: "newsletter" });
    // SES/SQS delivering the same object again.
    expect(await receiveInbound(w.deps, { rawKey: first.rawKey, envelopeTo: [sam.email] })).toEqual({ status: "skipped" });
    const second = await w.deliver(raw, { to: [sam.email] });
    expect(second.outcome).toMatchObject({ status: "newsletter", reason: "same_message" });
    if (first.outcome.status !== "newsletter" || second.outcome.status !== "newsletter") throw new Error("unreachable");
    expect(second.outcome.itemId).toBe(first.outcome.itemId);
    // No web version: a synthetic key, and the original's link is null.
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, first.outcome.itemId));
    expect(item!.canonicalUrl).toMatch(/^newsletter:\/\/[0-9a-f]{40}$/);
    expect(item!.authorName).toBe("Jordan");
  });

  it("shows a Gmail forwarding confirmation instead of making a newsletter of it", async () => {
    const w = createWorld();
    const sam = await newUser();
    const { rawKey, outcome } = await w.deliver(fixture("gmail-forwarding-confirmation"), { to: [sam.email] });
    expect(outcome).toEqual({
      status: "confirmation",
      confirmation: expect.objectContaining({ provider: "gmail", code: "284716395", requestedBy: "sam.reader@example.com" }),
    });
    const row = await messageRow(rawKey);
    expect(row).toMatchObject({ status: "confirmation", userId: sam.id, sourceId: null, itemId: null });
    expect(await db.select().from(userSource).where(eq(userSource.userId, sam.id))).toEqual([]);
  });

  it("refuses unknown and rotated addresses, and reads the recipient from headers without an envelope", async () => {
    const w = createWorld();
    const sam = await newUser();
    const unknown = await w.deliver(fixture("substack-post"), { to: [`n-aaaaaaaaaaaa@${DOMAIN}`] });
    expect(unknown.outcome).toEqual({ status: "rejected", reason: "unknown_recipient" });
    expect((await messageRow(unknown.rawKey)).userId).toBeNull();
    expect(w.mailObjects.has(unknown.rawKey)).toBe(false);

    const old = sam.email;
    const fresh = await rotateInboundAddress(db, sam.id, () => newInboundLocalPart());
    const rotated = await w.deliver(fixture("substack-post"), { to: [old] });
    expect(rotated.outcome).toEqual({ status: "rejected", reason: "inactive_address" });
    expect(await messageRow(rotated.rawKey)).toMatchObject({ userId: sam.id, status: "rejected" });
    // The new address keeps the same import, so its sources stay grouped.
    expect(fresh.importId).toBe(sam.address.importId);

    // No envelope (headers only): the Gmail confirmation is addressed to the new address in To.
    const raw = fixture("gmail-forwarding-confirmation").replaceAll("n-placeholder0@inbound.localhost", `${fresh.localPart}@${DOMAIN}`);
    expect((await w.deliver(raw, { to: null })).outcome).toMatchObject({ status: "confirmation" });
  });

  it("links a newsletter to the RSS item with the same URL, and still offers it to the reader", async () => {
    const w = createWorld();
    const sam = await newUser();
    const rssSource = await addUserSource(db, {
      userId: (await newUser()).id,
      mode: "more_like_this",
      detected: {
        type: "feed",
        canonicalKey: `https://thebootstrappedoperator.substack.com/feed?${randomUUID()}`,
        inputUrl: "https://thebootstrappedoperator.substack.com/",
        fetchUrl: "https://thebootstrappedoperator.substack.com/feed",
        title: "The Bootstrapped Operator",
        creator: null,
        publisher: { key: "thebootstrappedoperator.substack.com", name: "The Bootstrapped Operator", feedUrl: null },
      },
    });
    const [rssItem] = await db
      .insert(contentItem)
      .values({ canonicalUrl: SUBSTACK_URL, type: "article", sourceId: rssSource, publisherId: (await db.select().from(source).where(eq(source.id, rssSource)))[0]!.publisherId, title: "Pricing your first productized service", status: "extracted" })
      .returning();

    const { outcome } = await w.deliver(variant(fixture("substack-post"), "rss"), { to: [sam.email] });
    expect(outcome).toMatchObject({ status: "newsletter", itemId: rssItem!.id, reason: "same_url" });
    // Sam doesn't follow the feed, but the email makes it his candidate.
    expect(await ownCandidateIds(db, { userId: sam.id, window: WINDOW, limit: 50 })).toContain(rssItem!.id);
  });

  it("keeps its own copy when the item at that URL isn't readable yet (pending or paywalled)", async () => {
    const w = createWorld();
    const sam = await newUser();
    const [pub] = await db.select().from(publisher).where(eq(publisher.key, "thebootstrappedoperator.substack.com"));
    await db.insert(contentItem).values({ canonicalUrl: SUBSTACK_URL, type: "article", publisherId: pub!.id, status: "metadata_only", statusReason: "paywalled" });
    const { outcome } = await w.deliver(variant(fixture("substack-post"), "paywalled"), { to: [sam.email] });
    if (outcome.status !== "newsletter") throw new Error(`expected a newsletter, got ${outcome.status}`);
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, outcome.itemId));
    expect(item).toMatchObject({ status: "extracted" });
    expect(item!.canonicalUrl).toMatch(/^newsletter:\/\//);
  });

  it("collapses a near-duplicate of a readable item (same text, different URL)", async () => {
    const w = createWorld();
    const sam = await newUser();
    const first = await w.deliver(variant(fixture("substack-post"), "near-1"), { to: [sam.email] });
    if (first.outcome.status !== "newsletter") throw new Error("unreachable");
    // Make the first copy's URL different, so only the text matches.
    await db.update(contentItem).set({ canonicalUrl: `https://mirror.example/${randomUUID()}` }).where(eq(contentItem.id, first.outcome.itemId));
    const second = await w.deliver(variant(fixture("substack-post"), "near-2"), { to: [sam.email] });
    expect(second.outcome).toMatchObject({ status: "newsletter", itemId: first.outcome.itemId, reason: "near_duplicate" });
  });

  it("ignores a sender the user stopped following", async () => {
    const w = createWorld();
    const sam = await newUser();
    const first = await w.deliver(variant(fixture("beehiiv-newsletter"), "stop-1"), { to: [sam.email] });
    if (first.outcome.status !== "newsletter") throw new Error("unreachable");
    await db.update(userSource).set({ blocked: true }).where(and(eq(userSource.userId, sam.id), eq(userSource.sourceId, first.outcome.sourceId)));
    expect((await w.deliver(variant(fixture("beehiiv-newsletter"), "stop-2"), { to: [sam.email] })).outcome).toEqual({ status: "rejected", reason: "not_following" });
  });

  it("drops viruses, keeps spam marked, refuses oversized and empty mail", async () => {
    const w = createWorld();
    const sam = await newUser();
    expect((await w.deliver(fixture("substack-post"), { to: [sam.email], verdicts: { virus: "FAIL" } })).outcome).toEqual({ status: "rejected", reason: "virus" });
    const spam = await w.deliver(variant(fixture("beehiiv-newsletter"), "spam"), { to: [sam.email], verdicts: { spam: "FAIL", dkim: "PASS" } });
    expect(spam.outcome).toMatchObject({ status: "newsletter" });
    expect(await messageRow(spam.rawKey)).toMatchObject({ spam: true, verdicts: { spam: "FAIL", dkim: "PASS" } });

    const huge = `From: a@b.example\r\nTo: ${sam.email}\r\nSubject: big\r\n\r\n${"x".repeat(5 * 1024 * 1024 + 10)}`;
    expect((await w.deliver(huge, { to: [sam.email] })).outcome).toEqual({ status: "rejected", reason: "too_large" });
    const empty = `From: a@b.example\r\nTo: ${sam.email}\r\nSubject: hi\r\n\r\nSee you next week!\r\n`;
    expect((await w.deliver(empty, { to: [sam.email] })).outcome).toEqual({ status: "rejected", reason: "no_content" });
    expect((await w.deliver("\u0000\u0001garbage", { to: [sam.email] })).outcome).toEqual({ status: "failed", reason: "malformed" });
  });

  it("rate-limits an address", async () => {
    const w = createWorld();
    const sam = await newUser();
    await db.insert(inboundMessage).values(
      Array.from({ length: INBOUND_PER_HOUR }, () => ({ rawKey: `inbound/flood-${randomUUID()}`, addressId: sam.address.id, userId: sam.id, status: "rejected" as const, reason: "no_content" })),
    );
    expect((await w.deliver(fixture("substack-post"), { to: [sam.email] })).outcome).toEqual({ status: "rejected", reason: "rate_limited" });
  });

  it("unwraps a manual forward: the newsletter, not the person forwarding, is the sender", async () => {
    const w = createWorld();
    const sam = await newUser();
    const body = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} about pricing, customers and the work of turning a service into a product people can buy without a call.`).join("\r\n\r\n");
    const raw = `From: Sam Reader <sam.reader@example.com>\r\nTo: ${sam.email}\r\nSubject: Fwd: Pricing Weekly #9\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\nMessage-ID: <${randomUUID()}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nFor the pool\r\n\r\n---------- Forwarded message ---------\r\nFrom: Pricing Weekly <hello@pricingweekly.com>\r\nDate: Sun, Oct 4, 2026 at 7:00 AM\r\nSubject: Pricing Weekly #9\r\nTo: <sam.reader@example.com>\r\n\r\n${body}\r\n`;
    const { outcome } = await w.deliver(raw, { to: [sam.email] });
    if (outcome.status !== "newsletter") throw new Error(`expected a newsletter, got ${JSON.stringify(outcome)}`);
    const [src] = await db.select().from(source).where(eq(source.id, outcome.sourceId));
    expect(src).toMatchObject({ title: "Pricing Weekly", inputUrl: "mailto:hello@pricingweekly.com" });
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, outcome.itemId));
    expect(item).toMatchObject({ title: "Pricing Weekly #9" });
  });

  it("never offers one reader's newsletter to someone else through the shared pool", async () => {
    const w = createWorld();
    const sam = await newUser();
    const other = await newUser();
    const { outcome } = await w.deliver(variant(fixture("beehiiv-newsletter"), "pool"), { to: [sam.email] });
    if (outcome.status !== "newsletter") throw new Error("unreachable");
    await db.update(publisher).set({ status: "trusted" }).where(eq(publisher.key, "founderopsweekly.com"));
    const pool = await sharedPoolRows(db, { userId: other.id, windowDays: 3650, limit: 500 });
    expect(pool.map((p) => p.itemId)).not.toContain(outcome.itemId);
    await db.update(publisher).set({ status: "candidate" }).where(eq(publisher.key, "founderopsweekly.com"));
  });

  it("processes what the local dev route stored", async () => {
    const w = createWorld();
    const sam = await newUser();
    const rawKey = `inbound/dev-${randomUUID()}.eml`;
    await w.mail.put(rawKey, new TextEncoder().encode(variant(fixture("beehiiv-newsletter"), "dev")));
    await db.insert(inboundMessage).values({ rawKey, envelopeTo: [sam.email] });
    expect(await processPendingInbound(w.deps)).toBeGreaterThanOrEqual(1);
    expect((await messageRow(rawKey)).status).toBe("newsletter");
  });
});

describe("deliveryFromSesMessage", () => {
  const notification = {
    notificationType: "Received",
    mail: { timestamp: "2026-10-05T08:02:05.000Z", messageId: "o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1" },
    receipt: {
      recipients: ["N-AbcdefghijKL@in.example.com"],
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "GRAY" },
      dmarcVerdict: { status: "PASS" },
      action: { type: "S3", topicArn: "arn:aws:sns:ap-southeast-2:1:t", bucketName: "mail-bucket", objectKeyPrefix: "inbound/", objectKey: "inbound/o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1" },
    },
  };

  it("reads SES's notification (raw delivery or inside an SNS envelope)", () => {
    const expected = {
      rawKey: "inbound/o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1",
      envelopeTo: ["n-abcdefghijkl@in.example.com"],
      verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "GRAY", dmarc: "PASS" },
      receivedAt: new Date("2026-10-05T08:02:05.000Z"),
    };
    expect(deliveryFromSesMessage(JSON.stringify(notification), { bucket: "mail-bucket" })).toEqual(expected);
    expect(deliveryFromSesMessage(JSON.stringify({ Type: "Notification", Message: JSON.stringify(notification) }), { bucket: "mail-bucket" })).toEqual(expected);
    // An objectKey without the prefix gets it.
    const bare = { ...notification, receipt: { ...notification.receipt, action: { ...notification.receipt.action, objectKey: "abc" } } };
    expect(deliveryFromSesMessage(JSON.stringify(bare), { bucket: "mail-bucket" })?.rawKey).toBe("inbound/abc");
  });

  it("ignores anything else", () => {
    expect(deliveryFromSesMessage(JSON.stringify(notification), { bucket: "other-bucket" })).toBeNull();
    expect(deliveryFromSesMessage(JSON.stringify({ Type: "SubscriptionConfirmation" }), { bucket: "mail-bucket" })).toBeNull();
    expect(deliveryFromSesMessage("not json", { bucket: "mail-bucket" })).toBeNull();
  });
});
