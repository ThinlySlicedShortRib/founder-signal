import { randomUUID } from "node:crypto";
import type { AuthorEnricher, AuthorQuery, LetterWriter } from "@fs/ai";
import { FEEDBACK_CODE_PATTERN, leadSentences, type WriterInput } from "@fs/core";
import { addUserSource, createDb, type NewSource, schema } from "@fs/db";
import type { FetchResult } from "@fs/ingest";
import type { PieceImage } from "@fs/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { contentKeys, memoryContentStore } from "../src/lib/content-store.ts";
import { drain } from "../src/lib/local.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import { enrichAuthor } from "../src/letters/authors.ts";
import { sweepLetters } from "../src/letters/sweep.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";
import { dispatch } from "../src/pipeline/dispatch.ts";
import { sweep } from "../src/pipeline/sweep.ts";

const { author, contentItem, contentVersion, letter, letterItem, profile, publisher, review, schedule, source, topicWeight, user, userSource } = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

// Earlier tests' schedules and sources stay in the shared database; keep them out of the way.
beforeEach(async () => {
  await db.update(schedule).set({ nextRunAt: null });
  await db.update(source).set({ nextFetchAt: null });
  await db.update(letter).set({ watchdogAt: null }).where(sql`${letter.status} in ('scheduled', 'collecting', 'ranking', 'generating', 'verifying')`);
});

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Writes copy from the passages like a well-behaved model; `bad` refs get an invented number. */
function fakeWriter({ bad = new Set<string>(), fail = false }: { bad?: Set<string>; fail?: boolean } = {}) {
  const calls: WriterInput[] = [];
  const writer: LetterWriter = {
    method: "fake",
    model: "fake-model",
    promptVersion: "letter-v1",
    async write(input) {
      calls.push(structuredClone(input));
      if (fail) throw new Error("model unavailable");
      const picks = input.pieces.slice(0, input.pickCount);
      const minutes = picks.reduce((s, p) => s + p.minutes, 0);
      return {
        headline: "Model headline",
        intro: `${picks.length} things I picked. ${minutes} minutes in all.`,
        postscript: `In short: ${picks.map((p) => `“${p.title}”`).join(", ")}.`,
        pieces: input.pieces.map((p) => ({
          ref: p.ref,
          whyPicked: p.signals.find((s) => s.kind === "topic") ? `On ${p.topic.toLowerCase()}.` : null,
          summary: bad.has(p.ref) ? "They grew revenue by 987654 dollars overnight." : leadSentences(p.passages[0]!.text),
          tag: p.allowedTags[0] ?? null,
          evidenceIds: [p.passages[0]!.id],
        })),
      };
    },
  };
  return { writer, calls };
}

function createWorld(over: Partial<PipelineDeps> = {}) {
  const mq = memoryQueues();
  const { store, objects } = memoryContentStore();
  const web = new Map<string, { status?: number; contentType?: string; body: string }>();
  const { writer, calls } = fakeWriter();
  const deps: PipelineDeps = {
    db,
    queues: mq.queues,
    store,
    async fetch(url): Promise<FetchResult> {
      const page = web.get(url);
      return { status: page ? (page.status ?? 200) : 404, url, contentType: page?.contentType ?? "text/html", headers: new Headers(), body: page?.body ?? "" };
    },
    youtube: null,
    transcripts: null,
    enricher: null,
    letterWriter: writer,
    authorEnricher: null,
    stockPhotos: null,
    images: null,
    discovery: null,
    politenessMs: 0,
    log: () => {},
    ...over,
  };
  return { mq, store, objects, web, deps, writerCalls: calls };
}

async function newUser({ topics = ["pricing", "hiring"], lately = null as string | null } = {}) {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "t", email: `${id}@example.com` });
  await db.insert(profile).values({ userId: id, role: "founder", lately });
  if (topics.length) await db.insert(topicWeight).values(topics.map((topic) => ({ userId: id, topic, origin: "explicit" as const })));
  return id;
}

async function addSchedule(userId: string, nextRunAt: Date | null, over: Partial<typeof schedule.$inferInsert> = {}) {
  await db.insert(schedule).values({ userId, weekdays: [0, 1, 2, 3, 4, 5, 6], localTime: "07:30", timeZone: "Europe/London", nextRunAt, ...over });
}

const sourceFor = (site: string): NewSource => ({
  type: "feed",
  canonicalKey: `https://${site}/feed.xml`,
  inputUrl: `https://${site}/`,
  fetchUrl: `https://${site}/feed.xml`,
  title: site,
  creator: null,
  publisher: { key: site, name: `${site} Weekly`, feedUrl: `https://${site}/feed.xml` },
});

const paragraph = (topic: string, n: number) =>
  `${topic} matters for founders because every early decision compounds over time, and paragraph ${n} explains how with care.`;

/** An extracted article from `site`, followed by `userId`, with its blocks in the store. */
async function seedArticle(
  w: ReturnType<typeof createWorld>,
  userId: string,
  site: string,
  {
    title,
    topic = "pricing",
    daysOld = 1,
    leadImageUrl = null as string | null,
    authorName = null as string | null,
    mode = "more_like_this" as const,
    type = "article" as "article" | "video",
  }: { title: string; topic?: string; daysOld?: number; leadImageUrl?: string | null; authorName?: string | null; mode?: "more_like_this"; type?: "article" | "video" },
) {
  const sourceId = await addUserSource(db, { userId, mode, detected: sourceFor(site) });
  await db.update(source).set({ nextFetchAt: null }).where(eq(source.id, sourceId));
  const [src] = await db.select().from(source).where(eq(source.id, sourceId));
  const [item] = await db
    .insert(contentItem)
    .values({
      canonicalUrl: `https://${site}/${randomUUID()}`,
      type,
      externalId: type === "video" ? "vid123" : null,
      sourceId,
      publisherId: src!.publisherId,
      title,
      status: "extracted",
      wordCount: 900,
      readTimeMinutes: 4,
      publishedAt: new Date(Date.now() - daysOld * 86_400_000),
      leadImageUrl,
      authorName,
      authorKey: authorName ? `${site}:${authorName.toLowerCase().replace(/\s+/g, "-")}` : null,
      tags: [topic],
    })
    .returning();
  const blocks = [1, 2, 3].map((n) => ({ type: "paragraph" as const, text: paragraph(topic, n) }));
  const key = contentKeys.blocks(item!.id, "h1");
  await w.store.putJson(key, { blocks, sections: [{ id: "s1", title: null, startBlock: 0, endBlock: 3 }] });
  await db.insert(contentVersion).values({
    itemId: item!.id,
    contentHash: "h1",
    blocksKey: key,
    sectionMap: [{ id: "s1", title: null, startBlock: 0, endBlock: 3 }],
    rightsSnapshot: { display: "full_text", retainText: true, offlineAllowed: true, storeBlocks: true, digest: false, unavailableReason: null },
    excerpt: paragraph(topic, 1),
  });
  return item!;
}

/** What the API's POST /me/schedule/test-letter inserts locally (no queue: the watchdog starts it). */
async function insertTestLetter(userId: string) {
  const [row] = await db
    .insert(letter)
    .values({ userId, occurrenceId: `test#${randomUUID()}`, isTest: true, scheduledFor: new Date(), localDate: "2026-10-04", watchdogAt: new Date() })
    .returning();
  return row!;
}

const lettersOf = (userId: string) => db.select().from(letter).where(eq(letter.userId, userId)).orderBy(letter.createdAt);
const itemsOf = (letterId: string) => db.select().from(letterItem).where(eq(letterItem.letterId, letterId)).orderBy(letterItem.position);

async function threePublishers(w: ReturnType<typeof createWorld>, userId: string, prefix: string) {
  return [
    await seedArticle(w, userId, `${prefix}-a.test`, { title: "How we priced our first contract", topic: "pricing" }),
    await seedArticle(w, userId, `${prefix}-b.test`, { title: "Hiring your first engineer", topic: "hiring" }),
    await seedArticle(w, userId, `${prefix}-c.test`, { title: "Notes on sales calls", topic: "sales", daysOld: 3 }),
    await seedArticle(w, userId, `${prefix}-d.test`, { title: "Pricing pages that convert", topic: "pricing", daysOld: 5 }),
  ];
}

// ── Scheduling and idempotency ──────────────────────────────────────────────

describe("scheduled letters", () => {
  it("runs a due schedule end to end: collect → rank → generate → verify → lock → ready → sent", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "e2e");
    const runAt = new Date(Date.now() + 30 * 60_000);
    await addSchedule(userId, runAt);

    expect(await sweepLetters(w.deps)).toMatchObject({ lettersScheduled: 1 });
    await drain(w.deps, w.mq);

    const [l] = await lettersOf(userId);
    // Assembled ahead of time; not due yet.
    expect(l).toMatchObject({ status: "ready", isTest: false, short: false, headline: "Model headline", number: null, deliveredAt: null });
    expect(l!.occurrenceId).toMatch(/^\d{4}-\d{2}-\d{2}#1$/);
    expect(l!.scheduledFor.getTime()).toBe(runAt.getTime());
    expect(l!.generationMeta).toMatchObject({ method: "fake", model: "fake-model", promptVersion: "letter-v1", calls: 1, rejected: [] });
    expect(l!.generationMeta!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(l!.leanings.length).toBeGreaterThanOrEqual(2);
    expect(l!.leanings.at(-1)).toBe("Something new");
    expect(l!.stepAttempts).toEqual({ collecting: 1, ranking: 1, generating: 1, verifying: 1 });
    // The writer's P.S. is stored as the default recap, for the pieces it was written for.
    expect(l!.postscriptDefault).toBe(`In short: ${(await itemsOf(l!.id)).map((i) => `“${i.snapshot.title}”`).join(", ")}.`);
    expect(l!.postscriptRecap).toBeNull();

    const items = await itemsOf(l!.id);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.feedbackCode)).size).toBe(3);
    for (const i of items) {
      expect(i.feedbackCode).toMatch(FEEDBACK_CODE_PATTERN);
      expect(i.snapshot.summary).toContain("matters for founders");
      expect(i.snapshot.evidenceIds).toHaveLength(1);
      expect(i.pickSignals.length).toBeGreaterThan(0);
    }
    // One per publisher, and the topics the user asked for first.
    const pubs = await db.select({ p: contentItem.publisherId }).from(contentItem).where(inArray(contentItem.id, items.map((i) => i.itemId)));
    expect(new Set(pubs.map((p) => p.p)).size).toBe(3);
    expect(items.map((i) => i.snapshot.topic).sort()).toEqual(["Hiring", "Pricing", "Sales"]);

    // The schedule moved on to the next run, in the user's zone.
    const [s] = await db.select().from(schedule).where(eq(schedule.userId, userId));
    expect(s!.nextRunAt!.getTime()).toBeGreaterThan(runAt.getTime());

    // When it's due, the sweep delivers it, numbered.
    await db.update(letter).set({ scheduledFor: new Date(Date.now() - 1000) }).where(eq(letter.id, l!.id));
    expect(await sweepLetters(w.deps)).toMatchObject({ lettersDelivered: 1 });
    const [sent] = await lettersOf(userId);
    expect(sent).toMatchObject({ status: "sent", number: 1 });
    expect(sent!.deliveredAt).toBeInstanceOf(Date);
  });

  it("duplicate-sweep chaos: N concurrent sweeps create exactly one letter", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "chaos");
    await addSchedule(userId, new Date(Date.now() + 10 * 60_000));

    const results = await Promise.all(Array.from({ length: 12 }, () => sweep(w.deps)));
    expect(results.reduce((n, r) => n + r.lettersScheduled, 0)).toBe(1);
    expect(w.mq.pending.filter((m) => m.queue === "letter-step")).toHaveLength(1);

    // A retried sweep that sees the same occurrence again (e.g. it crashed before advancing next_run_at) adds nothing.
    const [l] = await lettersOf(userId);
    await db.update(schedule).set({ nextRunAt: l!.scheduledFor }).where(eq(schedule.userId, userId));
    await Promise.all(Array.from({ length: 6 }, () => sweepLetters(w.deps)));
    expect(await lettersOf(userId)).toHaveLength(1);

    // Duplicate messages for every step do nothing extra either.
    w.mq.pending.push(...w.mq.pending.map((m) => ({ ...m })));
    await drain(w.deps, w.mq);
    const letters = await lettersOf(userId);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.status).toBe("ready");
    expect(await itemsOf(letters[0]!.id)).toHaveLength(3);
    expect(w.writerCalls).toHaveLength(1);
  });

  it("ignores a stale or duplicate step message", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "stale");
    const l = await insertTestLetter(userId);
    expect(await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "scheduled" })).toMatchObject({ status: "collected" });
    expect(await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "scheduled" })).toEqual({ status: "stale" });
    expect(await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "generating" })).toEqual({ status: "stale" });
  });

  it("records 'skip next' as a skipped occurrence without running the pipeline", async () => {
    const w = createWorld();
    const userId = await newUser();
    await addSchedule(userId, new Date(Date.now() + 5 * 60_000), { skipNext: true });
    await sweepLetters(w.deps);
    const [l] = await lettersOf(userId);
    expect(l).toMatchObject({ status: "skipped" });
    expect(w.mq.pending).toHaveLength(0);
    const [s] = await db.select().from(schedule).where(eq(schedule.userId, userId));
    expect(s!.skipNext).toBe(false);
  });

  it("skips a run missed by hours rather than sending it late, and leaves paused schedules alone", async () => {
    const w = createWorld();
    const missed = await newUser();
    await addSchedule(missed, new Date(Date.now() - 24 * 3_600_000));
    const paused = await newUser();
    await addSchedule(paused, new Date(Date.now() - 60_000), { paused: true });
    await sweepLetters(w.deps);
    expect(await lettersOf(missed)).toHaveLength(0);
    expect((await db.select().from(schedule).where(eq(schedule.userId, missed)))[0]!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await lettersOf(paused)).toHaveLength(0);
  });

  it("numbers delivered letters per user and never repeats a piece", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "repeat");
    await seedArticle(w, userId, "repeat-e.test", { title: "More hiring notes", topic: "hiring" });
    await seedArticle(w, userId, "repeat-f.test", { title: "Even more sales", topic: "sales" });

    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);

    const [first, second] = await lettersOf(userId);
    expect([first!.number, second!.number]).toEqual([1, 2]);
    const a = (await itemsOf(first!.id)).map((i) => i.itemId);
    const b = (await itemsOf(second!.id)).map((i) => i.itemId);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
});

// ── Test letters ────────────────────────────────────────────────────────────

describe("test letters", () => {
  it("is picked up by the watchdog, delivered as soon as it's ready, and leaves next_run_at alone", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "test");
    const next = new Date(Date.now() + 3 * 86_400_000);
    await addSchedule(userId, next);
    // The beforeEach-style reset would clear this; set it after.
    await db.update(schedule).set({ nextRunAt: next }).where(eq(schedule.userId, userId));
    const l = await insertTestLetter(userId);

    expect(await sweepLetters(w.deps)).toMatchObject({ lettersRequeued: 1, lettersScheduled: 0 });
    await drain(w.deps, w.mq);
    const [done] = await lettersOf(userId);
    expect(done).toMatchObject({ id: l.id, status: "sent", isTest: true, number: 1 });
    expect((await db.select().from(schedule).where(eq(schedule.userId, userId)))[0]!.nextRunAt!.getTime()).toBe(next.getTime());
  });
});

// ── Collect ─────────────────────────────────────────────────────────────────

describe("collect", () => {
  it("skips a letter with no candidates", async () => {
    const w = createWorld();
    const userId = await newUser();
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    expect(l).toMatchObject({ status: "skipped_no_candidates", failureReason: "no candidates" });
  });

  it("leaves out reviewed, duplicate, thin, metadata-only, blocked and unfollowed items", async () => {
    const w = createWorld();
    const userId = await newUser();
    const good = await seedArticle(w, userId, "c-good.test", { title: "Pricing well" });
    const reviewed = await seedArticle(w, userId, "c-rev.test", { title: "Pricing reviewed" });
    await db.insert(review).values({ userId, itemId: reviewed.id, vote: "interested", origin: "onboarding" });
    const thin = await seedArticle(w, userId, "c-thin.test", { title: "Pricing thin" });
    await db.update(contentItem).set({ qualityLabel: "thin" }).where(eq(contentItem.id, thin.id));
    const dupe = await seedArticle(w, userId, "c-dupe.test", { title: "Pricing dupe" });
    await db.update(contentItem).set({ duplicateOfId: good.id, status: "failed" }).where(eq(contentItem.id, dupe.id));
    // A video without a transcript is metadata-only ("saved, no skim"), never a candidate.
    const video = await seedArticle(w, userId, "c-video.test", { title: "Pricing video", type: "video" });
    await db.update(contentItem).set({ status: "metadata_only", statusReason: "transcript_missing" }).where(eq(contentItem.id, video.id));
    const blocked = await seedArticle(w, userId, "c-blocked.test", { title: "Pricing blocked" });
    await db.update(userSource).set({ blocked: true }).where(and(eq(userSource.userId, userId), eq(userSource.sourceId, blocked.sourceId!)));
    const other = await newUser();
    await seedArticle(w, other, "c-other.test", { title: "Pricing for someone else" });

    const l = await insertTestLetter(userId);
    await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "scheduled" });
    const [row] = await db.select().from(letter).where(eq(letter.id, l.id));
    expect(row!.work.candidates).toEqual([good.id]);
  });
});

// ── Verification ────────────────────────────────────────────────────────────

describe("verify", () => {
  it("regenerates a piece with an unsupported number once, then substitutes it from the reserve", async () => {
    const userId = await newUser();
    const probe = createWorld();
    const [a, b, c, d] = await threePublishers(probe, userId, "verify");
    const { writer, calls } = fakeWriter({ bad: new Set([a!.id]) });
    const w = { ...probe, deps: { ...probe.deps, letterWriter: writer } };

    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);

    const [l] = await lettersOf(userId);
    expect(l!.status).toBe("sent");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.pieces.map((p) => p.ref)).toEqual([a!.id]);
    expect(l!.generationMeta).toMatchObject({ calls: 2, rejected: [{ itemId: a!.id, reasons: ["summary_number_unsupported:987654"] }] });
    const ids = (await itemsOf(l!.id)).map((i) => i.itemId);
    expect(ids).not.toContain(a!.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([b!.id, c!.id]));
    expect(ids).toContain(d!.id);
    // The pieces changed, so the cover line and the P.S. are recomputed rather than the model's.
    const titles = (await itemsOf(l!.id)).map((i) => i.snapshot.title);
    expect(l!.intro!.startsWith(`For a founder: start with “${titles[0]}”, then two more`)).toBe(true);
    expect(l!.intro!.endsWith(" 12 minutes in all.")).toBe(true);
    expect(l!.postscriptDefault).toBe(`Today was “${titles[0]}”, “${titles[1]}” and “${titles[2]}”. Tell me which were worth your time.`);
  });

  it("writes from the pieces' own words when the model fails", async () => {
    const { writer } = fakeWriter({ fail: true });
    const w = createWorld({ letterWriter: writer });
    const userId = await newUser();
    await threePublishers(w, userId, "fallback");
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    expect(l).toMatchObject({ status: "sent", headline: expect.stringMatching(/, for a founder$/) });
    expect(l!.generationMeta).toMatchObject({ method: "fallback", model: null, fallbackReason: "model unavailable" });
    expect(l!.postscriptDefault).toMatch(/^Today was “.+”, “.+” and “.+”\. Tell me which were worth your time\.$/);
    for (const i of await itemsOf(l!.id)) expect(i.snapshot.summary).toBe(paragraph(i.snapshot.topic.toLowerCase(), 1));
  });

  it("sends a short letter, or skips it when that's the user's policy", async () => {
    const w = createWorld();
    const shorten = await newUser();
    await seedArticle(w, shorten, "short-a.test", { title: "Pricing one" });
    await seedArticle(w, shorten, "short-b.test", { title: "Hiring two", topic: "hiring" });
    await insertTestLetter(shorten);
    const skip = await newUser();
    await addSchedule(skip, null, { shortLetterPolicy: "skip" });
    await seedArticle(w, skip, "skip-a.test", { title: "Pricing one" });
    await insertTestLetter(skip);

    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [s] = await lettersOf(shorten);
    expect(s).toMatchObject({ status: "short_sent", short: true });
    expect(await itemsOf(s!.id)).toHaveLength(2);
    const [k] = await lettersOf(skip);
    expect(k).toMatchObject({ status: "skipped_no_candidates", failureReason: "short letter skipped by policy" });
  });
});

// ── Watchdog ────────────────────────────────────────────────────────────────

describe("watchdog", () => {
  it("re-runs a step that died without releasing its claim", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "watch");
    const l = await insertTestLetter(userId);
    await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "scheduled" });
    await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "collecting" });
    w.mq.pending.length = 0;
    // A Lambda timeout mid-generate: status says generating, no drafts, and the message is gone.
    await db.update(letter).set({ status: "generating", watchdogAt: new Date(Date.now() - 1000) }).where(eq(letter.id, l.id));

    expect(await sweepLetters(w.deps)).toMatchObject({ lettersRequeued: 1 });
    expect((await db.select().from(letter).where(eq(letter.id, l.id)))[0]!.status).toBe("ranking");
    await drain(w.deps, w.mq);
    expect((await db.select().from(letter).where(eq(letter.id, l.id)))[0]!.status).toBe("sent");
  });

  it("moves on when a step finished but its next message was lost", async () => {
    const w = createWorld();
    const userId = await newUser();
    await threePublishers(w, userId, "lost");
    const l = await insertTestLetter(userId);
    await dispatch(w.deps, "letter-step", { letterId: l.id, expectedStatus: "scheduled" });
    w.mq.pending.length = 0;
    await db.update(letter).set({ watchdogAt: new Date(Date.now() - 1000) }).where(eq(letter.id, l.id));
    await sweepLetters(w.deps);
    expect(w.mq.pending.map((m) => m.body)).toEqual([{ letterId: l.id, expectedStatus: "collecting" }]);
  });

  it("releases a failed step for the queue's retry, then fails the letter after the attempt limit", async () => {
    const userId = await newUser();
    const base = createWorld();
    await threePublishers(base, userId, "flaky");
    let failures = 1;
    const flaky = {
      ...base.store,
      async getJson<T>(key: string) {
        if (failures-- > 0) throw new Error("S3 hiccup");
        return base.store.getJson<T>(key);
      },
    };
    const w = { ...base, deps: { ...base.deps, store: flaky } };
    const l = await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [ok] = await db.select().from(letter).where(eq(letter.id, l.id));
    expect(ok).toMatchObject({ status: "sent", stepAttempts: expect.objectContaining({ generating: 2 }) });

    const stuck = await insertTestLetter(userId);
    await db.update(letter).set({ status: "ranking", stepAttempts: { ranking: 3 }, watchdogAt: new Date(Date.now() - 1000) }).where(eq(letter.id, stuck.id));
    expect(await sweepLetters(w.deps)).toMatchObject({ lettersFailed: 1 });
    expect((await db.select().from(letter).where(eq(letter.id, stuck.id)))[0]).toMatchObject({ status: "failed", failureReason: "ranking: stuck" });
  });
});

// ── Lock: images, authors, P.S. ─────────────────────────────────────────────

describe("lock", () => {
  it("uses the article's lead image, else a stock photo for its topic", async () => {
    const used: string[] = [];
    const stockPhotos = {
      async forTopic(topic: string): Promise<PieceImage> {
        used.push(topic);
        return { url: "https://images.unsplash.com/photo-1?ixid=x", source: "stock", credit: "Jane Doe on Unsplash", creditUrl: "https://unsplash.com/@jane?utm_source=founder_signal&utm_medium=referral" };
      },
    };
    const w = createWorld({ stockPhotos });
    const userId = await newUser();
    const lead = await seedArticle(w, userId, "img-a.test", { title: "Pricing with a picture", leadImageUrl: "https://img-a.test/lead.jpg" });
    const plain = await seedArticle(w, userId, "img-b.test", { title: "Hiring without one", topic: "hiring" });
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    const items = await itemsOf(l!.id);
    expect(items.find((i) => i.itemId === lead.id)!.snapshot.image).toEqual({ url: "https://img-a.test/lead.jpg", source: "article", credit: null, creditUrl: null });
    expect(items.find((i) => i.itemId === plain.id)!.snapshot.image).toMatchObject({ source: "stock", credit: "Jane Doe on Unsplash" });
    expect(used).toEqual(["Hiring"]);
  });

  it("snapshots enrichment's icon, else one from the tags, topic and title", async () => {
    const w = createWorld();
    const userId = await newUser();
    const picked = await seedArticle(w, userId, "icon-a.test", { title: "Pricing that sticks" });
    await db.update(contentItem).set({ icon: "design" }).where(eq(contentItem.id, picked.id));
    const unpicked = await seedArticle(w, userId, "icon-b.test", { title: "Hiring your first engineer", topic: "hiring" });
    // An icon that's no longer on the allowlist falls back too.
    const stale = await seedArticle(w, userId, "icon-c.test", { title: "Sales calls", topic: "sales" });
    await db.update(contentItem).set({ icon: "retired-icon" }).where(eq(contentItem.id, stale.id));
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    const icons = new Map((await itemsOf(l!.id)).map((i) => [i.itemId, i.snapshot.icon]));
    expect(icons.get(picked.id)).toBe("design");
    expect(icons.get(unpicked.id)).toBe("hiring");
    expect(icons.get(stale.id)).toBe("sales");
  });

  it("uses our copy of the lead image when the image store has one", async () => {
    const images = { async copy(itemId: string, sourceUrl: string) { return sourceUrl.endsWith("/broken.jpg") ? null : `https://images.example.com/${itemId}.jpg`; } };
    const w = createWorld({ images });
    const userId = await newUser();
    const copied = await seedArticle(w, userId, "img-c.test", { title: "Pricing with a copied picture", leadImageUrl: "https://img-c.test/lead.jpg" });
    const broken = await seedArticle(w, userId, "img-d.test", { title: "Hiring with a broken picture", topic: "hiring", leadImageUrl: "https://img-d.test/broken.jpg" });
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    const items = await itemsOf(l!.id);
    expect(items.find((i) => i.itemId === copied.id)!.snapshot.image?.url).toBe(`https://images.example.com/${copied.id}.jpg`);
    expect(items.find((i) => i.itemId === broken.id)!.snapshot.image?.url).toBe("https://img-d.test/broken.jpg");
  });

  it("creates author cards and queues their enrichment once", async () => {
    const queries: AuthorQuery[] = [];
    const authorEnricher: AuthorEnricher = {
      method: "anthropic",
      model: "fake",
      async enrich(q) {
        queries.push(q);
        return {
          role: "Founder, clinic software",
          headline: "3 companies founded",
          short: "Writes up pricing decisions in public.",
          bio: "Founded three companies.",
          stats: [{ value: "3", label: "companies founded", source: { name: "Crunchbase", url: "https://crunchbase.com/p" } }],
          knownFor: ["Pricing write-ups"],
          siteUrl: "https://priya.test",
          followUrl: "https://priya.test/feed",
          sources: [{ name: "priya.test", url: "https://priya.test/about" }, { name: "Crunchbase", url: "https://crunchbase.com/p" }],
        };
      },
    };
    const w = createWorld({ authorEnricher });
    const userId = await newUser();
    await seedArticle(w, userId, "auth-a.test", { title: "Pricing in public", authorName: "Priya Raman" });
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);

    const [a] = await db.select().from(author).where(eq(author.key, "auth-a.test:priya-raman"));
    expect(a).toMatchObject({ name: "Priya Raman", initials: "PR", enrichmentStatus: "enriched", role: "Founder, clinic software", followUrl: "https://priya.test/feed" });
    expect(a!.provenance).toMatch(/^From priya\.test and Crunchbase, checked [A-Z][a-z]{2} \d{1,2}$/);
    expect(a!.stats[0]!.source.url).toBe("https://crunchbase.com/p");
    expect(queries).toEqual([{ name: "Priya Raman", publication: "auth-a.test Weekly", publicationUrl: "https://auth-a.test", titles: ["Pricing in public"], isChannel: false }]);
    // Already checked: a second message does nothing.
    expect(await enrichAuthor(w.deps, { authorKey: "auth-a.test:priya-raman" })).toEqual({ status: "skipped" });
  });

  it("keeps the card to just the name when nothing reliable is found", async () => {
    const w = createWorld({ authorEnricher: { method: "anthropic", model: "fake", enrich: async () => null } });
    await db.insert(author).values({ key: "nf.test:nobody", name: "No Body", initials: "NB" });
    expect(await enrichAuthor(w.deps, { authorKey: "nf.test:nobody" })).toEqual({ status: "not_found" });
    const [a] = await db.select().from(author).where(eq(author.key, "nf.test:nobody"));
    expect(a).toMatchObject({ enrichmentStatus: "not_found", role: null, stats: [], provenance: null });
    expect(a!.checkedAt).toBeInstanceOf(Date);
  });

  it("boosts the previous letter's chosen leanings and says so in 'why this mix'", async () => {
    const w = createWorld();
    const userId = await newUser({ topics: ["pricing"] });
    await threePublishers(w, userId, "lean");
    await seedArticle(w, userId, "lean-e.test", { title: "Sales playbooks for the first ten customers", topic: "sales", daysOld: 20 });
    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [first] = await lettersOf(userId);
    await db.update(letter).set({ chosenLeanings: ["Sales playbooks"] }).where(eq(letter.id, first!.id));
    const firstItems = await itemsOf(first!.id);
    await db.insert(review).values({ userId, itemId: firstItems[0]!.itemId, vote: "not_interested", reasons: ["too_basic"], origin: "in_app" });

    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [, second] = await lettersOf(userId);
    const items = await itemsOf(second!.id);
    const playbook = items.find((i) => i.snapshot.title.startsWith("Sales playbooks"));
    expect(playbook?.pickSignals).toContainEqual({ kind: "leaning", weight: 1.5, detail: "Sales playbooks" });
    expect(second!.whyThisMix).toMatch(/^Fewer beginner-level pieces, per your feedback on \d{1,2} [A-Z][a-z]{2}\. More of “Sales playbooks”, as you asked\.$/);
  });
});

// ── From a real feed ────────────────────────────────────────────────────────

describe("from ingestion to a letter", () => {
  it("ingests feeds, then writes a letter from what was extracted", async () => {
    const w = createWorld();
    const userId = await newUser({ topics: ["pricing"] });
    const words = "pricing customers retention service founders margin churn packaging sales trust cash focus".split(" ");
    const prose = (seed: number) =>
      Array.from({ length: 6 }, (_, p) => `<p>${Array.from({ length: 40 }, (_, i) => words[(p * 3 + i * 5 + seed) % words.length]).join(" ")} ${seed}.</p>`).join("");
    for (const [i, site] of ["feed-a.test", "feed-b.test", "feed-c.test"].entries()) {
      w.web.set(`https://${site}/feed.xml`, {
        contentType: "application/rss+xml",
        body: `<?xml version="1.0"?><rss version="2.0"><channel><title>${site}</title><item><title>Pricing note ${i}</title><link>https://${site}/p</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
      });
      w.web.set(`https://${site}/p`, {
        body: `<html lang="en"><head><title>Pricing note ${i}</title><meta name="author" content="Writer ${i}"><meta property="og:image" content="/lead.jpg"></head><body><article>${prose(i)}</article></body></html>`,
      });
      await addUserSource(db, { userId, mode: "more_like_this", detected: sourceFor(site) });
    }
    await sweep(w.deps);
    await drain(w.deps, w.mq);

    const extracted = await db.select().from(contentItem).where(sql`${contentItem.canonicalUrl} like 'https://feed-_.test/p'`);
    expect(extracted.map((e) => [e.status, e.authorName, e.leadImageUrl])).toEqual(
      expect.arrayContaining([["extracted", "Writer 0", "https://feed-a.test/lead.jpg"]]),
    );

    await insertTestLetter(userId);
    await sweepLetters(w.deps);
    await drain(w.deps, w.mq);
    const [l] = await lettersOf(userId);
    expect(l!.status).toBe("sent");
    const items = await itemsOf(l!.id);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.snapshot.image?.source === "article" && i.snapshot.author)).toBe(true);
    const pub = await db.select({ name: publisher.name }).from(publisher).where(eq(publisher.key, "feed-a.test"));
    expect(items.some((i) => i.snapshot.sourceName === pub[0]!.name)).toBe(true);
  });
});
