import { randomUUID } from "node:crypto";
import { type DiscoveryQueryGenerator, fallbackLetterWriter, type FoundPage, type SearchRequest, type WebSearcher } from "@fs/ai";
import { type DiscoveryBrief, DISCOVERY_LEAD_HOURS, type GeneratedQuery, localDateOf, MAX_QUERIES_PER_LETTER, normalizeQuery } from "@fs/core";
import { addUserSource, createDb, type NewSource, schema } from "@fs/db";
import type { FetchResult } from "@fs/ingest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluatePublishers, refreshUserPublisherBlocks } from "../src/discovery/catalog.ts";
import { discover, startDueDiscovery } from "../src/discovery/discover.ts";
import { contentKeys, memoryContentStore } from "../src/lib/content-store.ts";
import { drain } from "../src/lib/local.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import { sweepLetters } from "../src/letters/sweep.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";
import { sweep } from "../src/pipeline/sweep.ts";

const {
  contentItem,
  contentVersion,
  discoveryQuery,
  discoveryRun,
  discoverySearch,
  letter,
  letterItem,
  profile,
  publisher,
  review,
  schedule,
  source,
  topicWeight,
  user,
  userDiscovery,
  userPublisher,
} = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

// Earlier tests' schedules and sources stay in the shared database; keep them out of the way.
beforeEach(async () => {
  await db.update(schedule).set({ nextRunAt: null });
  await db.update(source).set({ nextFetchAt: null });
  await db.update(letter).set({ watchdogAt: null }).where(sql`${letter.status} in ('scheduled', 'collecting', 'ranking', 'generating', 'verifying')`);
  // The catalog pass would otherwise re-evaluate other tests' publishers mid-test.
  await db.update(publisher).set({ evaluatedAt: sql`now()` });
});

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A query generator that returns fixed queries, or fails. */
function fakeQueries(queries: GeneratedQuery[] | "fail") {
  const briefs: DiscoveryBrief[] = [];
  const generator: DiscoveryQueryGenerator = {
    method: "fake",
    model: "fake-haiku",
    promptVersion: "discovery-queries-test",
    async generate(brief) {
      briefs.push(structuredClone(brief));
      if (queries === "fail") throw new Error("model unavailable");
      return queries;
    },
  };
  return { generator, briefs };
}

/** A searcher that answers from a map of query → pages, recording what it was asked. */
function fakeSearch(answers: Record<string, FoundPage[]>) {
  const calls: SearchRequest[] = [];
  const searcher: WebSearcher = {
    method: "fake",
    model: "fake-sonnet",
    promptVersion: "discovery-search-test",
    async search(req) {
      calls.push(structuredClone(req));
      return { pages: answers[req.query] ?? [], webSearches: 2 };
    },
  };
  return { searcher, calls };
}

const q = (text: string, origin: GeneratedQuery["origin"] = "topic", originDetail: string | null = null): GeneratedQuery => ({ text, origin, originDetail });

const words = ["pricing", "customers", "retention", "service", "founders", "margin", "packaging", "sales", "trust", "cash", "focus", "contract"];
const prose = (n: number, seed: string) =>
  Array.from({ length: n }, (_, p) => `<p>${Array.from({ length: 40 }, (_, w) => words[(p * 5 + w * 7 + seed.length) % words.length]).join(" ")} ${seed} ${p}.</p>`).join("\n");
const articlePage = (title: string, site: string, head = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta property="og:site_name" content="${site}">${head}</head><body><article><h1>${title}</h1>${prose(6, title.length.toString())}</article></body></html>`;
const rss = (site: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${site}</title><link>https://${site}/</link></channel></rss>`;

function createWorld({ queries = [] as GeneratedQuery[] | "fail", answers = {} as Record<string, FoundPage[]>, discovery = true } = {}) {
  const mq = memoryQueues();
  const { store } = memoryContentStore();
  const web = new Map<string, { status?: number; contentType?: string; body: string }>();
  const requests: string[] = [];
  const qg = fakeQueries(queries);
  const search = fakeSearch(answers);
  const deps: PipelineDeps = {
    db,
    queues: mq.queues,
    store,
    async fetch(url): Promise<FetchResult> {
      requests.push(url);
      const page = web.get(url);
      return { status: page ? (page.status ?? 200) : 404, url, contentType: page?.contentType ?? "text/html", headers: new Headers(), body: page?.body ?? "" };
    },
    youtube: null,
    transcripts: null,
    enricher: null,
    letterWriter: fallbackLetterWriter,
    authorEnricher: null,
    stockPhotos: null,
    images: null,
    discovery: discovery ? { queries: qg.generator, search: search.searcher } : null,
    politenessMs: 0,
    log: () => {},
  };
  return { mq, store, web, requests, deps, briefs: qg.briefs, searches: search.calls };
}

async function newUser({ topics = ["pricing", "hiring", "sales"], lately = "moving from consulting to a product" as string | null } = {}) {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "t", email: `${id}@example.com` });
  await db.insert(profile).values({ userId: id, role: "founder", lately });
  if (topics.length) await db.insert(topicWeight).values(topics.map((topic) => ({ userId: id, topic, origin: "explicit" as const })));
  return id;
}

/** A schedule whose next letter is `hoursAway` from now. */
async function addSchedule(userId: string, hoursAway: number, over: Partial<typeof schedule.$inferInsert> = {}) {
  const nextRunAt = new Date(Date.now() + hoursAway * 3_600_000);
  await db.insert(schedule).values({ userId, weekdays: [0, 1, 2, 3, 4, 5, 6], localTime: "07:30", timeZone: "Europe/London", nextRunAt, ...over });
  return nextRunAt;
}

const runsOf = (userId: string) => db.select().from(discoveryRun).where(eq(discoveryRun.userId, userId)).orderBy(discoveryRun.createdAt);
const queriesOf = (runId: string) => db.select().from(discoveryQuery).where(eq(discoveryQuery.runId, runId)).orderBy(discoveryQuery.position);
/** Queries unique to a test: the search cache is shared across users, and so across tests. */
const uniq = (text: string) => `${text} ${randomUUID().slice(0, 6)}`;
const linksOf = (userId: string) => db.select().from(userDiscovery).where(eq(userDiscovery.userId, userId));

/** Starts a run for this user right now (as the sweep would) and drains everything it queues. */
async function runDiscoveryNow(w: ReturnType<typeof createWorld>, userId: string) {
  const [run] = await db
    .insert(discoveryRun)
    .values({ userId, occurrenceId: `manual#${randomUUID()}`, letterDueAt: new Date(Date.now() + 3_600_000) })
    .returning();
  const result = await discover(w.deps, { runId: run!.id });
  await drain(w.deps, w.mq);
  return { run: run!, result };
}

const site = (name: string) => `${name}-${randomUUID().slice(0, 8)}.test`;

/** An extracted article from a followed source on `host`, with its blocks stored. */
async function seedFollowed(w: ReturnType<typeof createWorld>, userId: string, host: string, title: string, topic: string) {
  const detected: NewSource = {
    type: "feed",
    canonicalKey: `https://${host}/feed.xml`,
    inputUrl: `https://${host}/`,
    fetchUrl: `https://${host}/feed.xml`,
    title: host,
    creator: null,
    publisher: { key: host, name: `${host} Weekly`, feedUrl: `https://${host}/feed.xml` },
  };
  const sourceId = await addUserSource(db, { userId, mode: "more_like_this", detected });
  await db.update(source).set({ nextFetchAt: null }).where(eq(source.id, sourceId));
  const [src] = await db.select().from(source).where(eq(source.id, sourceId));
  const [item] = await db
    .insert(contentItem)
    .values({
      canonicalUrl: `https://${host}/${randomUUID()}`,
      type: "article",
      sourceId,
      publisherId: src!.publisherId,
      title,
      status: "extracted",
      readTimeMinutes: 4,
      publishedAt: new Date(),
      tags: [topic],
    })
    .returning();
  const text = `${topic} matters for founders because every early decision compounds, and this piece explains how with care.`;
  const key = contentKeys.blocks(item!.id, "h1");
  await w.store.putJson(key, { blocks: [{ type: "paragraph", text }], sections: [{ id: "s1", title: null, startBlock: 0, endBlock: 1 }] });
  await db.insert(contentVersion).values({
    itemId: item!.id,
    contentHash: "h1",
    blocksKey: key,
    sectionMap: [],
    rightsSnapshot: { display: "full_text", retainText: true, offlineAllowed: true, storeBlocks: true, digest: false, unavailableReason: null },
    excerpt: text,
  });
  return item!;
}

// ── End to end ──────────────────────────────────────────────────────────────

describe("discovery end to end", () => {
  it("finds a URL → extracts it → it's a candidate → it lands in a letter with a `discovered` pick signal", async () => {
    const host = site("found");
    const url = `https://www.${host}/posts/raising-prices?utm_source=search`;
    const reason = "A founder's first-hand account of pricing a productized service";
    const w = createWorld({
      queries: [q("case study productized service pricing", "lately", "moving from consulting to a product")],
      answers: { "case study productized service pricing": [{ url, title: "Search result title (never shown)", reason }] },
    });
    // The page advertises its feed, which autodetection should find.
    w.web.set(`https://www.${host}/posts/raising-prices`, {
      body: articlePage("Raising prices on a productized service", "Found Weekly", `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`),
    });
    w.web.set(`https://www.${host}/feed.xml`, { contentType: "application/rss+xml", body: rss("Found Weekly") });

    const userId = await newUser();
    // Three followed pieces, one per topic, so the discovered one only gets in through the exploration slot.
    await seedFollowed(w, userId, site("a"), "Pricing your first contract", "pricing");
    await seedFollowed(w, userId, site("b"), "Hiring your first engineer", "hiring");
    await seedFollowed(w, userId, site("c"), "Sales calls that close", "sales");
    await addSchedule(userId, 2);

    // 1. The sweep starts discovery a few hours ahead (not the letter yet), once.
    const first = await sweep(w.deps);
    expect(first).toMatchObject({ discoveryStarted: 1, lettersScheduled: 0 });
    expect((await sweep(w.deps)).discoveryStarted).toBe(0);
    await drain(w.deps, w.mq);

    const [run] = await runsOf(userId);
    expect(run).toMatchObject({ status: "done", queryMethod: "fake", queryModel: "fake-haiku", queriesGenerated: 1, searchesRun: 2, cacheHits: 0, itemsLinked: 1, itemsQueued: 1 });
    expect(run!.occurrenceId).toMatch(/^\d{4}-\d{2}-\d{2}#1$/);
    expect(w.briefs[0]).toMatchObject({ role: "founder", lately: "moving from consulting to a product", topics: ["pricing", "hiring", "sales"] });
    // No personal details go to the model.
    expect(JSON.stringify(w.briefs[0])).not.toContain("@example.com");

    const [query] = await queriesOf(run!.id);
    expect(query).toMatchObject({ status: "searched", origin: "lately", originDetail: "moving from consulting to a product", resultCount: 1, acceptedCount: 1, method: "fake" });
    expect(query!.normalizedQuery).toBe(normalizeQuery("case study productized service pricing"));

    // 2. Normal ingestion: canonical URL, extraction from the page itself, a candidate publisher with its feed.
    const [link] = await linksOf(userId);
    expect(link).toMatchObject({ reason, queryId: query!.id });
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, link!.itemId));
    expect(item).toMatchObject({ canonicalUrl: `https://www.${host}/posts/raising-prices`, status: "extracted", sourceId: null, title: "Raising prices on a productized service" });
    const [pub] = await db.select().from(publisher).where(eq(publisher.id, item!.publisherId));
    expect(pub).toMatchObject({ key: host, name: "Found Weekly", origin: "discovered", status: "candidate", itemsSeen: 1, extractionsOk: 1, feedUrl: `https://www.${host}/feed.xml` });
    expect(pub!.feedCheckedAt).not.toBeNull();
    // Every fetch went through the injected (SSRF-safe in production) fetcher, to this site only.
    expect(w.requests.every((r) => r.includes(host))).toBe(true);

    // 3. The letter: collect → rank (exploration slot) → generate → verify → lock.
    await db.update(schedule).set({ nextRunAt: new Date(Date.now() + 30 * 60_000) }).where(eq(schedule.userId, userId));
    expect((await sweepLetters(w.deps)).lettersScheduled).toBe(1);
    await drain(w.deps, w.mq);

    const [l] = await db.select().from(letter).where(eq(letter.userId, userId));
    expect(l).toMatchObject({ status: "ready" });
    expect(l!.work.candidates).toContain(item!.id);

    const pieces = await db.select().from(letterItem).where(eq(letterItem.letterId, l!.id));
    expect(pieces).toHaveLength(3);
    const found = pieces.find((p) => p.itemId === item!.id)!;
    expect(found).toBeDefined();
    expect(found.pickSignals).toContainEqual({ kind: "discovered", weight: 0.5, detail: reason });
    expect(found.pickSignals.map((s) => s.kind)).toContain("exploration");
    expect(found.snapshot).toMatchObject({ title: "Raising prices on a productized service", sourceName: "Found Weekly", tag: "New source" });
    // Copy comes from the page, never from the search result.
    expect(JSON.stringify(found.snapshot)).not.toContain("Search result title");
    expect(found.snapshot.whyPicked).toBeTruthy();

    // 4. Its publisher's record: one verified piece.
    const [after] = await db.select().from(publisher).where(eq(publisher.id, pub!.id));
    expect(after!.verificationsPassed).toBe(1);
  });
});

describe("discovered duplicates", () => {
  it("counts a found page that's a repost as the original, keeping the search's reason", async () => {
    const w = createWorld();
    const userId = await newUser();
    const original = await seedFollowed(w, userId, site("orig"), "Pricing your first contract", "pricing");
    const mirror = site("mirror");
    const [pub] = await db.insert(publisher).values({ key: mirror, name: mirror, origin: "discovered" }).returning();
    const [repost] = await db
      .insert(contentItem)
      .values({ canonicalUrl: `https://${mirror}/copy`, type: "article", publisherId: pub!.id, status: "failed", statusReason: "near_duplicate", duplicateOfId: original.id })
      .returning();
    await db.insert(userDiscovery).values({ userId, itemId: repost!.id, reason: "Found again on a mirror" });

    const [l] = await db
      .insert(letter)
      .values({ userId, occurrenceId: `test#${randomUUID()}`, isTest: true, scheduledFor: new Date(), localDate: "2026-10-04" })
      .returning();
    await w.deps.queues.send("letter-step", { letterId: l!.id, expectedStatus: "scheduled" });
    await drain(w.deps, w.mq);
    const [piece] = await db.select().from(letterItem).where(eq(letterItem.letterId, l!.id));
    expect(piece!.itemId).toBe(original.id);
    expect(piece!.pickSignals).toContainEqual({ kind: "discovered", weight: 0.5, detail: "Found again on a mirror" });
  });
});

// ── Runs ────────────────────────────────────────────────────────────────────

describe("discovery runs", () => {
  it("only starts for schedules due within the lead time, before assembly, and not when skipped or paused", async () => {
    const w = createWorld();
    const due = await newUser();
    const tooEarly = await newUser();
    const assembling = await newUser();
    const skipped = await newUser();
    const dueAt = await addSchedule(due, DISCOVERY_LEAD_HOURS - 1);
    await addSchedule(tooEarly, DISCOVERY_LEAD_HOURS + 1);
    await addSchedule(assembling, 0.5);
    await addSchedule(skipped, 1, { skipNext: true });
    expect(await startDueDiscovery(w.deps, { leadHours: DISCOVERY_LEAD_HOURS })).toBe(1);
    // Keyed like the letter it feeds (letters/sweep.ts), so there's one run per letter.
    expect(await runsOf(due)).toMatchObject([{ occurrenceId: `${localDateOf(dueAt, "Europe/London")}#1`, letterDueAt: dueAt }]);
    expect(w.mq.pending.map((m) => m.queue)).toEqual(["discover"]);
  });

  it("does nothing when discovery is off", async () => {
    const w = createWorld({ discovery: false });
    const userId = await newUser();
    await addSchedule(userId, 1);
    expect(await startDueDiscovery(w.deps, { leadHours: DISCOVERY_LEAD_HOURS })).toBe(0);
    expect((await sweep(w.deps)).discoveryStarted).toBe(0);
  });

  it("ignores a duplicate or finished run message", async () => {
    const w = createWorld({ queries: [q(uniq("pricing lessons"))] });
    const userId = await newUser();
    const { run } = await runDiscoveryNow(w, userId);
    expect(await discover(w.deps, { runId: run.id })).toEqual({ status: "stale" });
    expect(w.searches).toHaveLength(1);
  });

  it("falls back to queries from the user's own topics when the generator fails, and records it", async () => {
    const w = createWorld({ queries: "fail" });
    const userId = await newUser({ topics: ["pricing"], lately: null });
    const { run } = await runDiscoveryNow(w, userId);
    const [r] = await runsOf(userId);
    expect(r).toMatchObject({ status: "done", queryMethod: "fallback", queryModel: null, queryPromptVersion: "fallback-v1" });
    expect(w.searches.map((s) => s.query)).toEqual(["pricing first-hand lessons for a founder"]);
    expect((await queriesOf(run.id))[0]).toMatchObject({ method: "fallback", origin: "topic", originDetail: "pricing" });
  });

  it("skips a user with nothing to search for", async () => {
    const w = createWorld({ queries: [q("anything")] });
    const userId = await newUser({ topics: [], lately: null });
    await runDiscoveryNow(w, userId);
    expect(await runsOf(userId)).toMatchObject([{ status: "done", error: "empty brief", queriesGenerated: 0 }]);
    expect(w.searches).toHaveLength(0);
  });

  it("caps searches per letter and logs every generated query with what happened to it", async () => {
    const texts = ["pricing", "hiring", "sales", "churn", "onboarding", "fundraising"].map(uniq);
    const w = createWorld({ queries: [...texts.map((t) => q(t)), q(texts[0]!.toUpperCase())] });
    const userId = await newUser();
    const { run } = await runDiscoveryNow(w, userId);
    expect(w.searches).toHaveLength(MAX_QUERIES_PER_LETTER);
    const statuses = (await queriesOf(run.id)).map((x) => x.status);
    expect(statuses.filter((s) => s === "searched")).toHaveLength(MAX_QUERIES_PER_LETTER);
    expect(statuses).toContain("skipped_cap");
    expect(statuses.at(-1)).toBe("duplicate");
  });

  it("skips queries the user ran recently, and ones that recently found nothing", async () => {
    const found = uniq("pricing lessons");
    const nothing = uniq("hiring stories");
    const w = createWorld({ queries: [q(found), q(nothing)], answers: { [found]: [{ url: `https://${site("x")}/post`, title: null, reason: "Good" }] } });
    const userId = await newUser();
    await runDiscoveryNow(w, userId);
    expect(w.searches).toHaveLength(2);
    const { run } = await runDiscoveryNow(w, userId);
    expect(w.searches).toHaveLength(2);
    expect((await queriesOf(run.id)).map((x) => x.status)).toEqual(["skipped_recent", "skipped_recent"]);

    // Ten days on, the one that found nothing is still skipped; the other would run again.
    await db
      .update(discoveryQuery)
      .set({ ranAt: sql`now() - interval '10 days'` })
      .where(and(eq(discoveryQuery.userId, userId), sql`${discoveryQuery.ranAt} is not null`));
    const third = await runDiscoveryNow(w, userId);
    expect((await queriesOf(third.run.id)).map((x) => x.status)).toEqual(["cached", "skipped_stale"]);
  });
});

// ── Cache, blocks and dedupe ────────────────────────────────────────────────

describe("shared search cache", () => {
  it("serves an overlapping query from another user's search without searching again", async () => {
    const host = site("shared");
    const url = `https://${host}/posts/one`;
    const tok = randomUUID().slice(0, 6);
    const answers = { [`productized service pricing ${tok}`]: [{ url, title: null, reason: "Numbers on pricing" }] };
    const w = createWorld({ queries: [q(`productized service pricing ${tok}`)], answers });
    w.web.set(url, { body: articlePage("Pricing one", "Shared") });

    const a = await newUser();
    const b = await newUser();
    await runDiscoveryNow(w, a);
    // The second user's generator words it differently; it normalizes to the same key.
    const w2 = { ...w, deps: { ...w.deps, discovery: { ...w.deps.discovery!, queries: fakeQueries([q(`Pricing productized services ${tok}`)]).generator } } };
    await runDiscoveryNow(w2, b);

    expect(w.searches).toHaveLength(1);
    const [rb] = await runsOf(b);
    expect(rb).toMatchObject({ searchesRun: 0, cacheHits: 1, itemsLinked: 1, itemsQueued: 0 });
    const [qb] = await queriesOf(rb!.id);
    expect(qb!.status).toBe("cached");
    const [cached] = await db.select().from(discoverySearch).where(eq(discoverySearch.id, qb!.searchId!));
    expect(cached).toMatchObject({ resultCount: 1, webSearches: 2, method: "fake", model: "fake-sonnet", promptVersion: "discovery-search-test" });
    expect(cached!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // One shared item, linked to both users.
    const [la] = await linksOf(a);
    const [lb] = await linksOf(b);
    expect(la!.itemId).toBe(lb!.itemId);
  });

  it("searches again once the cache has expired", async () => {
    const w = createWorld({ queries: [q(`expiring ${randomUUID().slice(0, 6)}`)] });
    const userId = await newUser();
    await runDiscoveryNow(w, userId);
    await db.update(discoverySearch).set({ expiresAt: sql`now() - interval '1 minute'` });
    await db.update(discoveryQuery).set({ ranAt: sql`now() - interval '30 days'`, acceptedCount: 1 }).where(eq(discoveryQuery.userId, userId));
    await runDiscoveryNow(w, userId);
    expect(w.searches).toHaveLength(2);
  });
});

describe("blocked publishers", () => {
  it("passes global and user blocks to the search and filters results by them", async () => {
    const good = site("good");
    const mine = site("mine");
    const farm = site("farm");
    const text = uniq("pricing posts");
    const w = createWorld({
      queries: [q(text)],
      answers: {
        [text]: [
          { url: `https://${good}/a`, title: null, reason: "Good" },
          { url: `https://blog.${mine}/b`, title: null, reason: "Blocked by the user" },
          { url: `https://${farm}/c`, title: null, reason: "Blocked for everyone" },
          { url: `https://www.pinterest.com/pin/1`, title: null, reason: "Never" },
        ],
      },
    });
    const userId = await newUser();
    const [minePub] = await db.insert(publisher).values({ key: mine, name: mine, origin: "discovered" }).returning();
    await db.insert(publisher).values({ key: farm, name: farm, origin: "discovered", status: "blocked" });
    await db.insert(userPublisher).values({ userId, publisherId: minePub!.id, blocked: true, blockedReason: "user" });

    await runDiscoveryNow(w, userId);
    expect(w.searches[0]!.blockedDomains).toEqual(expect.arrayContaining([mine, farm, "pinterest.com"]));
    const links = await linksOf(userId);
    expect(links).toHaveLength(1);
    const [item] = await db.select().from(contentItem).where(eq(contentItem.id, links[0]!.itemId));
    expect(item!.canonicalUrl).toBe(`https://${good}/a`);
  });

  it("blocks a discovered publisher for a user after their negative votes, and keeps it out of their letters", async () => {
    const host = site("meh");
    const w = createWorld();
    const userId = await newUser();
    const other = await newUser();
    const [pub] = await db.insert(publisher).values({ key: host, name: host, origin: "discovered" }).returning();
    const items = await db
      .insert(contentItem)
      .values([1, 2, 3].map((n) => ({ canonicalUrl: `https://${host}/${n}`, type: "article" as const, publisherId: pub!.id, title: `Pricing ${n}`, status: "extracted" as const })))
      .returning();
    await db.insert(review).values([
      { userId, itemId: items[0]!.id, vote: "not_interested", reasons: ["not_credible"], origin: "in_app" },
      { userId, itemId: items[1]!.id, vote: "not_interested", reasons: ["too_promotional"], origin: "in_app" },
    ]);
    expect(await refreshUserPublisherBlocks(db, userId)).toContain(host);
    expect(await refreshUserPublisherBlocks(db, other)).not.toContain(host);
    const [row] = await db.select().from(userPublisher).where(and(eq(userPublisher.userId, userId), eq(userPublisher.publisherId, pub!.id)));
    expect(row).toMatchObject({ blocked: true, blockedReason: "votes:distrusted" });

    // The unreviewed third piece, found for this user, isn't a candidate.
    await db.insert(userDiscovery).values({ userId, itemId: items[2]!.id, reason: "x" });
    await db.update(publisher).set({ status: "candidate" }).where(eq(publisher.id, pub!.id));
    const [l] = await db
      .insert(letter)
      .values({ userId, occurrenceId: `test#${randomUUID()}`, isTest: true, scheduledFor: new Date(), localDate: "2026-10-04" })
      .returning();
    await w.deps.queues.send("letter-step", { letterId: l!.id, expectedStatus: "scheduled" });
    await drain(w.deps, w.mq);
    const [done] = await db.select().from(letter).where(eq(letter.id, l!.id));
    expect(done!.status).toBe("skipped_no_candidates");
  });

  it("never overrides a user's own unblock with their votes", async () => {
    const host = site("forgiven");
    const userId = await newUser();
    const [pub] = await db.insert(publisher).values({ key: host, name: host, origin: "discovered" }).returning();
    await db.insert(userPublisher).values({ userId, publisherId: pub!.id, blocked: false, blockedReason: "user" });
    const items = await db
      .insert(contentItem)
      .values([1, 2].map((n) => ({ canonicalUrl: `https://${host}/${n}`, type: "article" as const, publisherId: pub!.id })))
      .returning();
    await db.insert(review).values(items.map((i) => ({ userId, itemId: i.id, vote: "not_interested" as const, reasons: ["not_credible"], origin: "in_app" as const })));
    expect(await refreshUserPublisherBlocks(db, userId)).not.toContain(host);
  });
});

// ── The publisher catalog ───────────────────────────────────────────────────

describe("publisher catalog", () => {
  async function discoveredPublisher(labels: (string | null)[], status: "candidate" | "trial" = "candidate", feedUrl: string | null = null) {
    const host = site("pub");
    const [pub] = await db.insert(publisher).values({ key: host, name: host, origin: "discovered", status, feedUrl, extractionsOk: labels.length }).returning();
    if (labels.length) {
      await db.insert(contentItem).values(
        labels.map((qualityLabel, n) => ({ canonicalUrl: `https://${host}/${n}`, type: "article" as const, publisherId: pub!.id, status: "enriched" as const, qualityLabel })),
      );
    }
    return { ...pub!, host };
  }
  const statusOf = async (id: string) => (await db.select().from(publisher).where(eq(publisher.id, id)))[0]!;

  it("promotes candidate → trial after a well-rated item, recording why", async () => {
    const p = await discoveredPublisher(["substantive"]);
    await evaluatePublishers(createWorld().deps, { publisherIds: [p.id] });
    expect(await statusOf(p.id)).toMatchObject({ status: "trial", statusReason: "well_rated_item", substantiveCount: 1 });
  });

  it("promotes to trusted after several good items and polls its feed as a shared source", async () => {
    const feedUrl = `https://feeds.${randomUUID().slice(0, 6)}.test/rss`;
    const p = await discoveredPublisher(["substantive", "substantive", "substantive", "substantive"], "trial", feedUrl);
    const w = createWorld();
    await evaluatePublishers(w.deps, { publisherIds: [p.id] });
    expect(await statusOf(p.id)).toMatchObject({ status: "trusted", statusReason: "several_good_items" });

    const [src] = await db.select().from(source).where(eq(source.publisherId, p.id));
    expect(src).toMatchObject({ type: "feed", fetchUrl: feedUrl });
    // Nobody follows it, but the sweep polls it because its publisher is trusted.
    const result = await sweep(w.deps);
    expect(result.sourcesClaimed).toBeGreaterThanOrEqual(1);
    expect(w.mq.pending.some((m) => m.queue === "fetch-source" && (m.body as { sourceId: string }).sourceId === src!.id)).toBe(true);
  });

  it("offers a trusted publisher's new feed items to users discovery showed it to", async () => {
    const p = await discoveredPublisher(["substantive"], "trial");
    await db.update(publisher).set({ status: "trusted" }).where(eq(publisher.id, p.id));
    const w = createWorld();
    const shown = await newUser();
    const notShown = await newUser();
    const [old] = await db.select().from(contentItem).where(eq(contentItem.publisherId, p.id));
    await db.insert(userDiscovery).values({ userId: shown, itemId: old!.id, reason: "x" });
    await db.insert(review).values({ userId: shown, itemId: old!.id, vote: "interested", origin: "in_app" });
    const [src] = await db
      .insert(source)
      .values({ canonicalKey: `https://${p.host}/feed`, type: "feed", publisherId: p.id, title: p.host, inputUrl: `https://${p.host}/feed`, fetchUrl: `https://${p.host}/feed` })
      .returning();
    const fresh = await seedFollowedLike(w, p.id, src!.id, p.host);

    for (const userId of [shown, notShown]) {
      const [l] = await db
        .insert(letter)
        .values({ userId, occurrenceId: `test#${randomUUID()}`, isTest: true, scheduledFor: new Date(), localDate: "2026-10-04" })
        .returning();
      await w.deps.queues.send("letter-step", { letterId: l!.id, expectedStatus: "scheduled" });
    }
    await drain(w.deps, w.mq);
    const items = async (userId: string) =>
      db.select({ itemId: letterItem.itemId }).from(letterItem).innerJoin(letter, eq(letter.id, letterItem.letterId)).where(eq(letter.userId, userId));
    expect((await items(shown)).map((i) => i.itemId)).toEqual([fresh.id]);
    expect(await items(notShown)).toEqual([]);
  });

  it("blocks a publisher globally for repeated low quality, and its pages are no longer linked", async () => {
    const p = await discoveredPublisher(["thin", "seo_filler", "thin"]);
    await evaluatePublishers(createWorld().deps, { publisherIds: [p.id] });
    expect(await statusOf(p.id)).toMatchObject({ status: "blocked", statusReason: "low_quality", lowQualityCount: 3 });

    const text = `farm ${randomUUID().slice(0, 6)}`;
    const w = createWorld({ queries: [q(text)], answers: { [text]: [{ url: `https://${p.host}/new`, title: null, reason: "x" }] } });
    const userId = await newUser();
    await runDiscoveryNow(w, userId);
    expect(await linksOf(userId)).toEqual([]);
  });

  it("leaves user-added publishers alone", async () => {
    const host = site("mine");
    const [pub] = await db.insert(publisher).values({ key: host, name: host, origin: "user_added" }).returning();
    await db.insert(contentItem).values({ canonicalUrl: `https://${host}/1`, type: "article", publisherId: pub!.id, qualityLabel: "thin" });
    await db.update(publisher).set({ evaluatedAt: null }).where(eq(publisher.id, pub!.id));
    expect((await evaluatePublishers(createWorld().deps, { publisherIds: [pub!.id] })).evaluated).toBe(0);
  });
});

/** A new extracted item on a shared (unfollowed) source, with its blocks stored. */
async function seedFollowedLike(w: ReturnType<typeof createWorld>, publisherId: string, sourceId: string, host: string) {
  const [item] = await db
    .insert(contentItem)
    .values({ canonicalUrl: `https://${host}/fresh`, type: "article", sourceId, publisherId, title: "Pricing fresh", status: "extracted", publishedAt: new Date(), tags: ["pricing"] })
    .returning();
  const text = "Pricing matters for founders because every early decision compounds, and this piece explains how with care.";
  const key = contentKeys.blocks(item!.id, "h1");
  await w.store.putJson(key, { blocks: [{ type: "paragraph", text }], sections: [] });
  await db.insert(contentVersion).values({
    itemId: item!.id,
    contentHash: "h1",
    blocksKey: key,
    sectionMap: [],
    rightsSnapshot: { display: "full_text", retainText: true, offlineAllowed: true, storeBlocks: true, digest: false, unavailableReason: null },
    excerpt: text,
  });
  return item!;
}
