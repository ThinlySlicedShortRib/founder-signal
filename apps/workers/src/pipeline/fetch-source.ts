import { nextFetch } from "@fs/core";
import { schema } from "@fs/db";
import { canonicalizeUrl, FetchError, parseFeed, parseYouTubeUrl, youTubeVideoUrl } from "@fs/ingest";
import { eq, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "./deps.ts";
import type { Message } from "./messages.ts";

const { contentItem, publisher, source } = schema;

/** A brand-new feed shouldn't backfill its whole archive. */
const FIRST_FETCH_LIMIT = 10;
/** Later fetches only look at the newest entries; older ones were seen before. */
const FETCH_LIMIT = 25;

interface Candidate {
  url: string;
  type: "article" | "video";
  externalId?: string;
  title?: string | null;
  creator?: string | null;
  publishedAt?: Date | null;
}

/**
 * Lists a source's entries and queues extraction for the new ones. A new item
 * is inserted as `pending` with ON CONFLICT DO NOTHING, so an entry seen
 * again (or a redelivered message) never queues a second extraction.
 */
export async function fetchSource(deps: PipelineDeps, { sourceId }: Message<"fetch-source">) {
  const { db, queues } = deps;
  const log = logger(deps);
  const now = deps.now?.() ?? new Date();

  const [src] = await db.select().from(source).where(eq(source.id, sourceId));
  if (!src) return { status: "missing" as const, queued: 0 };
  const firstFetch = src.lastFetchedAt === null;
  const limit = firstFetch ? FIRST_FETCH_LIMIT : FETCH_LIMIT;

  let candidates: Candidate[] = [];
  let status = "ok";
  let ok = true;
  let etag = src.etag;
  let lastModified = src.lastModified;

  try {
    if (src.type === "feed") {
      const res = await deps.fetch(src.fetchUrl, {
        accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5",
        etag: src.etag,
        lastModified: src.lastModified,
      });
      if (res.status === 304) {
        status = "not_modified";
      } else if (res.status >= 400) {
        ok = false;
        status = `http_${res.status}`;
      } else {
        const feed = parseFeed(res.body, res.url);
        if (!feed) {
          ok = false;
          status = "not_a_feed";
        } else {
          etag = res.headers.get("etag");
          lastModified = res.headers.get("last-modified");
          candidates = feed.entries.slice(0, limit).map((e) => {
            const yt = parseYouTubeUrl(e.url);
            return yt?.kind === "video"
              ? { url: youTubeVideoUrl(yt.videoId), type: "video", externalId: yt.videoId, title: e.title, creator: e.author, publishedAt: e.publishedAt }
              : { url: e.url, type: "article", title: e.title, creator: e.author, publishedAt: e.publishedAt };
          });
        }
      }
    } else if (src.type === "youtube_channel") {
      if (!deps.youtube) {
        ok = false;
        status = "youtube_unavailable";
      } else {
        const videos = await deps.youtube.listUploads(src.fetchUrl, limit);
        candidates = videos.map((v) => ({
          url: youTubeVideoUrl(v.videoId),
          type: "video",
          externalId: v.videoId,
          title: v.title,
          creator: v.channelTitle,
          publishedAt: v.publishedAt,
        }));
      }
    } else {
      const yt = parseYouTubeUrl(src.fetchUrl);
      candidates = [
        yt?.kind === "video"
          ? { url: youTubeVideoUrl(yt.videoId), type: "video", externalId: yt.videoId, title: src.title, creator: src.creator }
          : { url: src.fetchUrl, type: "article" },
      ];
    }
  } catch (err) {
    // Unreachable feeds back off rather than retrying through the queue.
    if (!(err instanceof FetchError)) throw err;
    ok = false;
    status = `fetch_${err.reason}`;
  }

  const newItemIds: string[] = [];
  for (const c of candidates) {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(c.url);
    } catch {
      continue;
    }
    const [inserted] = await db
      .insert(contentItem)
      .values({
        canonicalUrl,
        type: c.type,
        externalId: c.externalId,
        sourceId: src.id,
        publisherId: src.publisherId,
        title: c.title ?? null,
        creator: c.creator ?? null,
        publishedAt: c.publishedAt ?? null,
      })
      .onConflictDoNothing({ target: contentItem.canonicalUrl })
      .returning({ id: contentItem.id });
    if (inserted) newItemIds.push(inserted.id);
  }

  const next = nextFetch(now, { ok, oneShot: src.type === "url", previousFailures: src.consecutiveFailures });
  await db
    .update(source)
    .set({
      lastFetchedAt: now,
      lastFetchStatus: status,
      etag,
      lastModified,
      nextFetchAt: next.nextFetchAt,
      consecutiveFailures: next.consecutiveFailures,
    })
    .where(eq(source.id, src.id));
  if (newItemIds.length) {
    await db
      .update(publisher)
      .set({ itemsSeen: sql`${publisher.itemsSeen} + ${newItemIds.length}` })
      .where(eq(publisher.id, src.publisherId));
  }

  for (const itemId of newItemIds) await queues.send("extract", { itemId });
  log("fetch_source", { sourceId, type: src.type, status, entries: candidates.length, queued: newItemIds.length });
  return { status, queued: newItemIds.length };
}
