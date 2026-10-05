import { randomUUID } from "node:crypto";
import { fallbackLetterWriter, type WebSearcher } from "@fs/ai";
import { addUserSource, createDb, schema } from "@fs/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryContentStore } from "../src/lib/content-store.ts";
import { runDevRequests } from "../src/lib/dev-requests.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import { sweepLetters } from "../src/letters/sweep.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";

const { discoveryRun, letter, profile, source, topicWeight, user } = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

// Other files' sources and letters stay in the shared database; keep them out of the way.
beforeEach(async () => {
  // Earlier tests' discoveries and trusted publishers would be this test's shared pool (letter-supply.ts); clear them.
  await db.execute(sql`delete from user_discovery`);
  await db.execute(sql`update publisher set status = 'candidate' where status = 'trusted'`);
  await db.update(source).set({ nextFetchAt: null });
  await db.update(letter).set({ watchdogAt: null }).where(sql`${letter.status} in ('scheduled', 'collecting', 'ranking', 'generating', 'verifying')`);
  await db.update(discoveryRun).set({ status: "done" }).where(eq(discoveryRun.status, "pending"));
});

function createWorld({ discovery = true, brokenQuery = false } = {}) {
  const mq = memoryQueues();
  const searches: string[] = [];
  const search: WebSearcher = {
    method: "fake",
    model: "fake-sonnet",
    promptVersion: "t",
    async search(req) {
      searches.push(req.query);
      return { pages: [], webSearches: 1 };
    },
  };
  const deps: PipelineDeps = {
    db,
    queues: mq.queues,
    store: memoryContentStore().store,
    fetch: async (url) => ({ status: 404, url, contentType: "text/html", headers: new Headers(), body: "" }),
    youtube: null,
    transcripts: null,
    enricher: null,
    letterWriter: fallbackLetterWriter,
    authorEnricher: null,
    stockPhotos: null,
    images: null,
    discovery: discovery
      ? {
          queries: {
            method: "fake",
            model: "fake-haiku",
            promptVersion: "t",
            async generate() {
              // A query without text makes the run itself throw (not just one query fail).
              if (brokenQuery) return [{ text: null as unknown as string, origin: "topic", originDetail: null }];
              return [{ text: `pricing ${randomUUID().slice(0, 6)}`, origin: "topic", originDetail: "pricing" }];
            },
          },
          search,
        }
      : null,
    politenessMs: 0,
    log: () => {},
  };
  return { mq, deps, searches };
}

async function newUser() {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "t", email: `${id}@example.com` });
  await db.insert(profile).values({ userId: id, role: "founder", lately: "clinic pricing" });
  await db.insert(topicWeight).values({ userId: id, topic: "pricing", origin: "explicit" });
  return id;
}

/** What POST /dev/letter { discoverFirst: true } writes. */
async function discoverFirstLetter(userId: string) {
  const id = randomUUID();
  const [run] = await db.insert(discoveryRun).values({ userId, occurrenceId: `dev#${id}`, letterDueAt: new Date() }).returning();
  const [l] = await db
    .insert(letter)
    .values({ userId, occurrenceId: `test#${id}`, isTest: true, scheduledFor: new Date(), localDate: "2026-10-04", watchdogAt: null })
    .returning();
  return { run: run!, letter: l! };
}

const runOf = async (id: string) => (await db.select().from(discoveryRun).where(eq(discoveryRun.id, id)))[0]!;
const letterOf = async (id: string) => (await db.select().from(letter).where(eq(letter.id, id)))[0]!;

describe("dev runner requests", () => {
  it("runs a requested discovery run, then releases the letter waiting on it", async () => {
    const w = createWorld();
    const userId = await newUser();
    const { run, letter: l } = await discoverFirstLetter(userId);

    // The letter sweep doesn't start a held letter.
    await sweepLetters(w.deps);
    expect(w.mq.pending.filter((m) => m.queue === "letter-step")).toEqual([]);

    await runDevRequests(w.deps);
    expect(await runOf(run.id)).toMatchObject({ status: "done", queriesGenerated: 1, searchesRun: 1 });
    expect(w.searches).toHaveLength(1);
    // Released on the next pass, after what discovery queued has been drained.
    expect((await letterOf(l.id)).watchdogAt).toBeNull();

    await runDevRequests(w.deps);
    expect((await letterOf(l.id)).watchdogAt).not.toBeNull();
    await sweepLetters(w.deps);
    expect(w.mq.pending.filter((m) => m.queue === "letter-step").map((m) => m.body)).toEqual([{ letterId: l.id, expectedStatus: "scheduled" }]);
  });

  it("marks a run that throws as failed, and still releases its letter", async () => {
    const w = createWorld({ brokenQuery: true });
    const userId = await newUser();
    const { run, letter: l } = await discoverFirstLetter(userId);
    await runDevRequests(w.deps);
    expect(await runOf(run.id)).toMatchObject({ status: "failed", error: expect.any(String) });
    await runDevRequests(w.deps);
    expect((await letterOf(l.id)).watchdogAt).not.toBeNull();
  });

  it("fails requested runs when discovery is off", async () => {
    const w = createWorld({ discovery: false });
    const userId = await newUser();
    const { run } = await discoverFirstLetter(userId);
    await runDevRequests(w.deps);
    expect(await runOf(run.id)).toMatchObject({ status: "failed", error: "Discovery is off (DISCOVERY=none)" });
  });

  it("leaves runs the sweep started (not dev#) to the queue", async () => {
    const w = createWorld();
    const userId = await newUser();
    const [run] = await db.insert(discoveryRun).values({ userId, occurrenceId: `2026-10-05#1`, letterDueAt: new Date() }).returning();
    await runDevRequests(w.deps);
    expect(await runOf(run!.id)).toMatchObject({ status: "pending" });
    await db.update(discoveryRun).set({ status: "done" }).where(eq(discoveryRun.id, run!.id));
  });

  it("asks for a sweep when a followed source is due", async () => {
    const w = createWorld();
    const userId = await newUser();
    expect(await runDevRequests(w.deps)).toEqual({ sweepNow: false });
    const host = `dev-${randomUUID().slice(0, 8)}.test`;
    const sourceId = await addUserSource(db, {
      userId,
      mode: "more_like_this",
      detected: {
        type: "feed",
        canonicalKey: `https://${host}/feed.xml`,
        inputUrl: `https://${host}/`,
        fetchUrl: `https://${host}/feed.xml`,
        title: host,
        creator: null,
        publisher: { key: host, name: host, feedUrl: `https://${host}/feed.xml` },
      },
    });
    await db.update(source).set({ nextFetchAt: sql`now()` }).where(eq(source.id, sourceId));
    expect(await runDevRequests(w.deps)).toEqual({ sweepNow: true });
    await db.update(source).set({ nextFetchAt: null }).where(eq(source.id, sourceId));
  });
});
