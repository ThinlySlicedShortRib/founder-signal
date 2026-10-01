import { randomUUID } from "node:crypto";
import type { EnrichmentBatches, EnrichmentInput, EnrichmentResult } from "@fs/ai";
import { addUserSource, createDb, type NewSource, schema } from "@fs/db";
import type { FetchResult, TranscriptProvider, YouTubeClient } from "@fs/ingest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryContentStore } from "../src/lib/content-store.ts";
import { drain } from "../src/lib/local.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";
import { dispatch } from "../src/pipeline/dispatch.ts";
import { RetryableError } from "../src/pipeline/extract.ts";
import { sweep } from "../src/pipeline/sweep.ts";

const { contentItem, contentVersion, enrichmentBatch, publisher, rightsRule, source, transcript, user, userSource } = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

// ── A fake web ──────────────────────────────────────────────────────────────

function prose(paragraphs: number, seed: string) {
  const words = ["pricing", "customers", "retention", "service", "founders", "margin", "churn", "packaging", "sales", "trust", "cash", "focus"];
  return Array.from({ length: paragraphs }, (_, p) =>
    `<p>${Array.from({ length: 40 }, (_, w) => words[(p * 5 + w * 7 + seed.length) % words.length]).join(" ")} ${seed} ${p}.</p>`,
  ).join("\n");
}

const articlePage = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta property="og:site_name" content="Test Site">${head}</head><body><article><h1>${title}</h1>${body}</article></body></html>`;

const paywallHead = `<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>`;

const rss = (site: string, links: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${site}</title><link>https://${site}/</link>${links
    .map((l, i) => `<item><title>Post ${i}</title><link>${l}</link><pubDate>Tue, 0${i + 1} Sep 2026 09:00:00 GMT</pubDate></item>`)
    .join("")}</channel></rss>`;

interface Page {
  status?: number;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
}

function createWorld() {
  const web = new Map<string, Page>();
  const requests: { url: string; etag?: string | null }[] = [];
  const mq = memoryQueues();
  const { store, objects } = memoryContentStore();

  const videos: Record<string, { title: string; transcript: boolean }> = {};
  const youtube: YouTubeClient = {
    async resolveChannel() {
      return null;
    },
    async listUploads() {
      return Object.entries(videos).map(([videoId, v]) => ({
        videoId,
        channelId: "UCtest",
        channelTitle: "Test Channel",
        title: v.title,
        description: "About the episode",
        publishedAt: new Date("2026-09-10T00:00:00Z"),
      }));
    },
    async getVideo() {
      return null;
    },
  };
  const transcripts: TranscriptProvider = {
    name: "fake",
    async get(videoId) {
      if (!videos[videoId]?.transcript) return null;
      return {
        segments: [{ text: `${videoId} transcript about pricing and customers`, offsetMs: 0, durationMs: 5000 }],
        provider: "fake",
        kind: "native",
        language: "en",
        confidence: null,
      };
    },
  };

  const submitted: EnrichmentInput[][] = [];
  const batchResults = new Map<string, EnrichmentResult[] | null>();
  const batches: EnrichmentBatches = {
    model: "test-model",
    promptVersion: "test-v1",
    async submit(inputs) {
      submitted.push(inputs);
      const id = `msgbatch_${randomUUID()}`;
      batchResults.set(id, null);
      return { providerBatchId: id };
    },
    async results(id) {
      return batchResults.get(id) ?? null;
    },
  };

  const deps: PipelineDeps = {
    db,
    queues: mq.queues,
    store,
    async fetch(url, options): Promise<FetchResult> {
      requests.push({ url, etag: options?.etag });
      const page = web.get(url);
      if (page?.headers?.etag && options?.etag === page.headers.etag) {
        return { status: 304, url, contentType: "", headers: new Headers(), body: "" };
      }
      return {
        status: page ? (page.status ?? 200) : 404,
        url,
        contentType: page?.contentType ?? "text/html",
        headers: new Headers(page?.headers),
        body: page?.body ?? "",
      };
    },
    youtube,
    transcripts,
    // Off by default so enrichment messages don't interleave with other tests' steps.
    enricher: null,
    politenessMs: 0,
    log: () => {},
  };

  const enricher = { batches, embedder: { modelId: "fake", embed: async () => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)) } };
  return { web, requests, mq, objects, videos, submitted, batchResults, deps, enricher };
}

async function newUser() {
  const id = randomUUID();
  await db.insert(user).values({ id, name: "t", email: `${id}@example.com` });
  return id;
}

async function follow(userId: string, detected: NewSource) {
  return addUserSource(db, { userId, mode: "more_like_this", detected });
}

const feedSource = (site: string): NewSource => ({
  type: "feed",
  canonicalKey: `https://${site}/feed.xml`,
  inputUrl: `https://${site}/`,
  fetchUrl: `https://${site}/feed.xml`,
  title: site,
  creator: null,
  publisher: { key: site, name: site, feedUrl: `https://${site}/feed.xml` },
});

async function itemsOf(sourceId: string) {
  return db
    .select({ item: contentItem, version: contentVersion })
    .from(contentItem)
    .leftJoin(contentVersion, eq(contentVersion.itemId, contentItem.id))
    .where(eq(contentItem.sourceId, sourceId))
    .orderBy(contentItem.canonicalUrl);
}

// Each test gets its own sites, but sources from earlier tests stay due; keep them out of the way.
beforeEach(async () => {
  await db.update(source).set({ nextFetchAt: null });
});

describe("feed ingestion", () => {
  it("ingests a feed: full text stored, paywalled and missing pages metadata-only", async () => {
    const w = createWorld();
    const site = "blog.test";
    w.web.set(`https://${site}/feed.xml`, {
      contentType: "application/rss+xml",
      body: rss(site, [`https://${site}/a?utm_source=rss`, `https://${site}/paywalled`, `https://${site}/gone`]),
      headers: { etag: '"v1"' },
    });
    w.web.set(`https://${site}/a`, { body: articlePage("Pricing a productized service", prose(10, "alpha")) });
    w.web.set(`https://${site}/paywalled`, { body: articlePage("Members only", prose(1, "beta") + '<div class="paywall">Subscribe</div>', paywallHead) });

    const sourceId = await follow(await newUser(), feedSource(site));
    expect(await sweep(w.deps)).toMatchObject({ sourcesClaimed: 1 });
    await drain(w.deps, w.mq);

    const rows = await itemsOf(sourceId);
    const byUrl = Object.fromEntries(rows.map((r) => [r.item.canonicalUrl, r]));

    const full = byUrl[`https://${site}/a`]!;
    expect(full.item).toMatchObject({ status: "extracted", title: "Post 0", language: "en", statusReason: null });
    expect(full.item.wordCount).toBeGreaterThan(300);
    expect(full.item.readTimeMinutes).toBeGreaterThanOrEqual(2);
    expect(full.version!.rightsSnapshot).toMatchObject({ display: "full_text", storeBlocks: true, offlineAllowed: true, digest: false });
    expect(w.objects.has(full.version!.blocksKey!)).toBe(true);
    expect(full.version!.excerpt).toBeTruthy();

    expect(byUrl[`https://${site}/paywalled`]!.item).toMatchObject({ status: "metadata_only", statusReason: "paywalled", title: "Post 1" });
    expect(byUrl[`https://${site}/paywalled`]!.version).toMatchObject({
      blocksKey: null,
      rightsSnapshot: expect.objectContaining({ display: "link_only", storeBlocks: false, unavailableReason: "paywalled" }),
    });
    expect(byUrl[`https://${site}/gone`]!.item).toMatchObject({ status: "metadata_only", statusReason: "not_found" });

    const [src] = await db.select().from(source).where(eq(source.id, sourceId));
    expect(src).toMatchObject({ lastFetchStatus: "ok", etag: '"v1"', consecutiveFailures: 0 });
    expect(src!.nextFetchAt!.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);

    const [pub] = await db.select().from(publisher).where(eq(publisher.key, site));
    expect(pub).toMatchObject({ itemsSeen: 3, extractionsOk: 1, extractionsFailed: 2, name: "Test Site" });
  });

  it("doesn't re-extract on the next poll, and uses conditional requests", async () => {
    const w = createWorld();
    const site = "again.test";
    w.web.set(`https://${site}/feed.xml`, {
      contentType: "application/rss+xml",
      body: rss(site, [`https://${site}/one`]),
      headers: { etag: '"e1"' },
    });
    w.web.set(`https://${site}/one`, { body: articlePage("One", prose(8, "gamma")) });
    const sourceId = await follow(await newUser(), feedSource(site));

    await sweep(w.deps);
    await drain(w.deps, w.mq);

    // Next poll: the feed answers 304.
    await db.update(source).set({ nextFetchAt: new Date(Date.now() - 1000) }).where(eq(source.id, sourceId));
    await sweep(w.deps);
    expect(await drain(w.deps, w.mq)).toBe(1);
    expect(w.requests.at(-1)).toEqual({ url: `https://${site}/feed.xml`, etag: '"e1"' });
    expect((await db.select().from(source).where(eq(source.id, sourceId)))[0]!.lastFetchStatus).toBe("not_modified");

    // Feed changed (new etag) but lists the same post: no new item, no extraction.
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, [`https://${site}/one`]), headers: { etag: '"e2"' } });
    await db.update(source).set({ nextFetchAt: new Date(Date.now() - 1000) }).where(eq(source.id, sourceId));
    await sweep(w.deps);
    expect(w.mq.pending.map((m) => m.queue)).toEqual(["fetch-source"]);
    await drain(w.deps, w.mq);
    expect(await itemsOf(sourceId)).toHaveLength(1);
  });

  it("claims a due source once even when sweeps overlap", async () => {
    const w = createWorld();
    const site = "overlap.test";
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, []) });
    await follow(await newUser(), feedSource(site));

    const results = await Promise.all([sweep(w.deps), sweep(w.deps), sweep(w.deps)]);
    expect(results.reduce((n, r) => n + r.sourcesClaimed, 0)).toBe(1);
    expect(w.mq.pending.filter((m) => m.queue === "fetch-source")).toHaveLength(1);
  });

  it("stops polling sources nobody follows", async () => {
    const w = createWorld();
    const site = "unfollowed.test";
    const userId = await newUser();
    const sourceId = await follow(userId, feedSource(site));
    await db.update(userSource).set({ blocked: true }).where(and(eq(userSource.userId, userId), eq(userSource.sourceId, sourceId)));
    expect(await sweep(w.deps)).toMatchObject({ sourcesClaimed: 0 });
  });

  it("backs off a failing feed", async () => {
    const w = createWorld();
    const site = "down.test";
    w.web.set(`https://${site}/feed.xml`, { status: 503 });
    const sourceId = await follow(await newUser(), feedSource(site));
    await sweep(w.deps);
    await drain(w.deps, w.mq);
    const [src] = await db.select().from(source).where(eq(source.id, sourceId));
    expect(src).toMatchObject({ lastFetchStatus: "http_503", consecutiveFailures: 1 });
    expect(src!.nextFetchAt!.getTime() - Date.now()).toBeLessThan(16 * 60_000);
  });
});

describe("extraction", () => {
  it("collapses a repost on another site into the original", async () => {
    const w = createWorld();
    const body = prose(12, "delta");
    w.web.set("https://original.test/feed.xml", { contentType: "application/rss+xml", body: rss("original.test", ["https://original.test/essay"]) });
    w.web.set("https://original.test/essay", { body: articlePage("The essay", body) });
    w.web.set("https://mirror.test/feed.xml", { contentType: "application/rss+xml", body: rss("mirror.test", ["https://mirror.test/copy"]) });
    w.web.set("https://mirror.test/copy", { body: articlePage("The essay (repost)", `${body}<p>Reposted with permission.</p>`) });

    const userId = await newUser();
    const originalId = await follow(userId, feedSource("original.test"));
    await sweep(w.deps);
    await drain(w.deps, w.mq);
    const mirrorId = await follow(userId, feedSource("mirror.test"));
    await sweep(w.deps);
    await drain(w.deps, w.mq);

    const [original] = await itemsOf(originalId);
    const [mirror] = await itemsOf(mirrorId);
    expect(mirror!.item).toMatchObject({ status: "failed", statusReason: "near_duplicate", duplicateOfId: original!.item.id });
  });

  it("applies a tighter rights rule: digest, not stored, not offline", async () => {
    const w = createWorld();
    const site = "strict.test";
    await db.insert(rightsRule).values({ scope: "domain", scopeKey: site, display: "excerpt_only", retainText: false, offlineAllowed: false });
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, [`https://${site}/p`]) });
    w.web.set(`https://${site}/p`, { body: articlePage("Strict", prose(8, "epsilon")) });
    const sourceId = await follow(await newUser(), feedSource(site));
    await sweep(w.deps);
    await drain(w.deps, w.mq);

    const [row] = await itemsOf(sourceId);
    expect(row!.item.status).toBe("extracted");
    expect(row!.version).toMatchObject({
      blocksKey: null,
      rightsSnapshot: expect.objectContaining({ display: "excerpt_only", storeBlocks: false, offlineAllowed: false, digest: true }),
    });
    expect(row!.version!.excerpt).toBeTruthy();
  });

  it("defers a second request to the same host", async () => {
    const w = createWorld();
    w.deps.politenessMs = 60_000;
    const site = "polite.test";
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, [`https://${site}/1`, `https://${site}/2`]) });
    await follow(await newUser(), feedSource(site));
    await sweep(w.deps);
    const fetchMsg = w.mq.take()!;
    await dispatch(w.deps, fetchMsg.queue, fetchMsg.body);
    const [first, second] = [w.mq.take()!, w.mq.take()!];
    expect(await dispatch(w.deps, first.queue, first.body)).toMatchObject({ status: "metadata_only" });
    expect(await dispatch(w.deps, second.queue, second.body)).toEqual({ status: "deferred" });
    expect(w.mq.pending).toHaveLength(1);
    expect(w.mq.pending[0]!.visibleAt - Date.now()).toBeGreaterThan(55_000);
  });

  it("retries server errors through the queue", async () => {
    const w = createWorld();
    const site = "flaky.test";
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, [`https://${site}/x`]) });
    w.web.set(`https://${site}/x`, { status: 503 });
    await follow(await newUser(), feedSource(site));
    await sweep(w.deps);
    const fetchMsg = w.mq.take()!;
    await dispatch(w.deps, fetchMsg.queue, fetchMsg.body);
    const extractMsg = w.mq.take()!;
    await expect(dispatch(w.deps, extractMsg.queue, extractMsg.body)).rejects.toBeInstanceOf(RetryableError);
  });
});

describe("YouTube", () => {
  it("lists a channel's uploads; videos without captions are saved without a skim", async () => {
    const w = createWorld();
    w.videos.vidWithCaps = { title: "Pricing episode", transcript: true };
    w.videos.vidNoCaps = { title: "Silent episode", transcript: false };
    const sourceId = await follow(await newUser(), {
      type: "youtube_channel",
      canonicalKey: "youtube:UCtest",
      inputUrl: "https://www.youtube.com/@test",
      fetchUrl: "UUtest",
      title: "Test Channel",
      creator: "Test Channel",
      publisher: { key: "youtube:UCtest", name: "Test Channel", feedUrl: null },
    });
    await sweep(w.deps);
    await drain(w.deps, w.mq);

    const rows = await itemsOf(sourceId);
    const byId = Object.fromEntries(rows.map((r) => [r.item.externalId, r]));
    expect(byId.vidWithCaps!.item).toMatchObject({ type: "video", status: "extracted", canonicalUrl: "https://www.youtube.com/watch?v=vidWithCaps" });
    expect(byId.vidNoCaps!.item).toMatchObject({ type: "video", status: "metadata_only", statusReason: "transcript_missing" });

    const [t] = await db.select().from(transcript).where(eq(transcript.itemVersionId, byId.vidWithCaps!.version!.id));
    expect(t).toMatchObject({ provider: "fake", provenance: "native", language: "en" });
    expect(w.objects.has(t!.key)).toBe(true);
    // A missing transcript isn't the channel's fault.
    expect((await db.select().from(publisher).where(eq(publisher.key, "youtube:UCtest")))[0]!.extractionsFailed).toBe(0);
  });
});

describe("enrichment", () => {
  it("batches extracted items, then applies tags, quality and an embedding", async () => {
    const w = createWorld();
    w.deps.enricher = w.enricher;
    const site = "enrich.test";
    w.web.set(`https://${site}/feed.xml`, { contentType: "application/rss+xml", body: rss(site, [`https://${site}/1`, `https://${site}/2`]) });
    w.web.set(`https://${site}/1`, { body: articlePage("First", prose(8, "zeta")) });
    w.web.set(`https://${site}/2`, { body: articlePage("Second", prose(8, "eta-longer")) });
    const sourceId = await follow(await newUser(), feedSource(site));
    await sweep(w.deps);
    await drain(w.deps, w.mq);

    // The sweep notices extracted items and queues a submission.
    await sweep(w.deps);
    await drain(w.deps, w.mq);
    const mine = (await itemsOf(sourceId)).map((r) => r.item);
    const inputs = w.submitted.flat().filter((i) => mine.some((m) => m.id === i.itemId));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.text).toContain("pricing");

    const [batch] = await db.select().from(enrichmentBatch).where(eq(enrichmentBatch.id, (await itemsOf(sourceId))[0]!.item.enrichmentBatchId!));
    expect(batch).toMatchObject({ status: "submitted", model: "test-model", promptVersion: "test-v1" });

    // Still processing: nothing changes.
    expect(await dispatch(w.deps, "enrich", { kind: "poll", batchId: batch!.id })).toEqual({ status: "processing" });

    const [a, b] = mine;
    w.batchResults.set(batch!.providerBatchId, [
      { itemId: a!.id, ok: true, enrichment: { tags: ["pricing", "services"], language: "en", depth: "intermediate", quality: "substantive", quality_reason: "x" } },
      { itemId: b!.id, ok: false, retryable: true, error: "overloaded_error" },
    ]);
    expect(await dispatch(w.deps, "enrich", { kind: "poll", batchId: batch!.id })).toEqual({ status: "applied", enriched: 1, failed: 1 });
    // Applying again is a no-op.
    expect(await dispatch(w.deps, "enrich", { kind: "poll", batchId: batch!.id })).toEqual({ status: "skipped" });

    const after = await db.select().from(contentItem).where(inArray(contentItem.id, [a!.id, b!.id])).orderBy(contentItem.canonicalUrl);
    expect(after[0]).toMatchObject({ status: "enriched", tags: ["pricing", "services"], depth: "intermediate", qualityLabel: "substantive" });
    expect(after[0]!.embedding).toHaveLength(1024);
    // The retryable failure goes back in the queue for the next batch.
    expect(after[1]).toMatchObject({ status: "extracted", enrichmentBatchId: null, enrichmentAttempts: 1 });
  });
});
