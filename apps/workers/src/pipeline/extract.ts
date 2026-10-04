import { createHash } from "node:crypto";
import { authorKeyFor, cleanAuthorName, countWords, decideItemAccess, type ItemAccess, readTimeMinutes, resolveRights } from "@fs/core";
import { loadRightsRules, schema } from "@fs/db";
import {
  canonicalizeUrl,
  extractArticle,
  FetchError,
  isUsableTranscript,
  NEAR_DUPLICATE_DISTANCE,
  publisherKeyForUrl,
  transcriptText,
} from "@fs/ingest";
import type { Rights, Section, UnavailableReason } from "@fs/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { contentKeys } from "../lib/content-store.ts";
import { logger, type PipelineDeps } from "./deps.ts";
import type { Message } from "./messages.ts";

const { contentItem, contentVersion, publisher, source, transcript } = schema;

/** Minimum gap between our requests to one host (build plan §6.3, politeness). */
export const PER_HOST_INTERVAL_MS = 2_000;

/** Thrown for failures worth retrying through the queue (5xx, timeouts); the DLQ catches the rest. */
export class RetryableError extends Error {}

type Item = typeof contentItem.$inferSelect;

/**
 * Fetches and extracts one item, applies the rights gate and records a
 * content version. Idempotent: it only acts on `pending` items, and versions
 * are unique per content hash.
 */
export async function extract(deps: PipelineDeps, { itemId }: Message<"extract">) {
  const { db } = deps;
  const log = logger(deps);

  const [row] = await db
    .select({ item: contentItem, publisherKey: publisher.key, publisherName: publisher.name, sourceKey: source.canonicalKey })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .leftJoin(source, eq(source.id, contentItem.sourceId))
    .where(eq(contentItem.id, itemId));
  if (!row || row.item.status !== "pending") return { status: "skipped" as const };

  const politenessMs = deps.politenessMs ?? PER_HOST_INTERVAL_MS;
  if (!(await claimHost(deps, row.item.publisherId, politenessMs))) {
    await deps.queues.send("extract", { itemId }, { delaySeconds: Math.ceil(politenessMs / 1000) + 1 });
    return { status: "deferred" as const };
  }

  const rights = resolveRights(await loadRightsRules(db, { publisherKeys: [row.publisherKey], sourceKeys: row.sourceKey ? [row.sourceKey] : [] }), {
    publisherKey: row.publisherKey,
    sourceKey: row.sourceKey,
  });

  const result = row.item.type === "video" ? await extractVideo(deps, row.item, rights, row) : await extractPage(deps, row.item, rights, row);
  log("extract", { itemId, type: row.item.type, status: result.status, reason: result.reason ?? null });
  return result;
}

/** Politeness: at most one request per host per interval, across all workers. */
async function claimHost(deps: PipelineDeps, publisherId: string, intervalMs: number): Promise<boolean> {
  const claimed = await deps.db
    .update(publisher)
    .set({ lastFetchedAt: sql`now()` })
    .where(
      and(
        eq(publisher.id, publisherId),
        sql`(${publisher.lastFetchedAt} is null or ${publisher.lastFetchedAt} < now() - make_interval(secs => ${intervalMs / 1000}))`,
      ),
    )
    .returning({ id: publisher.id });
  return claimed.length > 0;
}

async function extractPage(
  deps: PipelineDeps,
  item: Item,
  rights: Rights,
  ctx: { publisherKey: string; publisherName: string },
) {
  const { db } = deps;

  let page;
  try {
    page = await deps.fetch(item.canonicalUrl);
  } catch (err) {
    if (err instanceof FetchError && (err.reason === "timeout" || err.reason === "network")) {
      throw new RetryableError(`${err.reason} fetching ${item.canonicalUrl}`, { cause: err });
    }
    const reason: UnavailableReason = err instanceof FetchError && err.reason === "blocked_address" ? "blocked_address" : "fetch_failed";
    return markUnavailable(deps, item, rights, reason, null);
  }

  if (page.status >= 500 || page.status === 429) throw new RetryableError(`HTTP ${page.status} from ${item.canonicalUrl}`);
  if (page.status === 401 || page.status === 402 || page.status === 403) return markUnavailable(deps, item, rights, "access_denied", null);
  if (page.status >= 400) return markUnavailable(deps, item, rights, "not_found", null);
  if (!/html|xml/i.test(page.contentType)) return markUnavailable(deps, item, rights, "not_html", null);

  const article = extractArticle(page.body, page.url);
  const meta = article.metadata;

  // Same-site canonical links only: a cross-site canonical could hijack another item's identity.
  const preferred = meta.canonicalUrl && publisherKeyForUrl(meta.canonicalUrl) === publisherKeyForUrl(page.url) ? meta.canonicalUrl : page.url;
  const canonicalUrl = canonicalizeUrl(preferred);
  if (canonicalUrl !== item.canonicalUrl) {
    const [existing] = await db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.canonicalUrl, canonicalUrl));
    if (existing) return markDuplicate(deps, item, existing.id, "same_canonical_url");
    try {
      await db.update(contentItem).set({ canonicalUrl }).where(eq(contentItem.id, item.id));
    } catch (err) {
      // Another extraction claimed this canonical URL between our check and the update.
      if ((err as { cause?: { code?: string } }).cause?.code !== "23505") throw err;
      const [winner] = await db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.canonicalUrl, canonicalUrl));
      return markDuplicate(deps, item, winner!.id, "same_canonical_url");
    }
  }

  // Learn a readable publisher name the first time we see one.
  if (meta.siteName && ctx.publisherName === ctx.publisherKey) {
    await db.update(publisher).set({ name: meta.siteName }).where(and(eq(publisher.id, item.publisherId), eq(publisher.name, publisher.key)));
  }

  // The page's byline wins over the feed entry's author; neither is kept if it's really the site's name.
  const authorName = cleanAuthorName(meta.byline, meta.siteName ?? ctx.publisherName) ?? cleanAuthorName(item.creator, meta.siteName ?? ctx.publisherName);
  const details = {
    title: item.title ?? meta.title,
    creator: item.creator ?? meta.byline,
    publishedAt: item.publishedAt ?? meta.publishedAt,
    language: meta.language,
    authorName,
    authorKey: authorName ? authorKeyFor({ name: authorName, publisherKey: ctx.publisherKey }) : null,
    leadImageUrl: meta.leadImageUrl,
  };

  if (article.unavailableReason) return markUnavailable(deps, item, rights, article.unavailableReason, details);

  if (article.simhash !== null) {
    const [dupe] = await db
      .select({ id: contentItem.id })
      .from(contentItem)
      .where(
        and(
          ne(contentItem.id, item.id),
          sql`${contentItem.simhash} is not null`,
          sql`${contentItem.duplicateOfId} is null`,
          sql`bit_count(int8send(${contentItem.simhash} # ${article.simhash})) <= ${NEAR_DUPLICATE_DISTANCE}`,
        ),
      )
      .limit(1);
    if (dupe) return markDuplicate(deps, item, dupe.id, "near_duplicate");
  }

  const access = decideItemAccess(rights, { unavailableReason: null });
  const blocksKey = access.storeBlocks ? contentKeys.blocks(item.id, article.contentHash) : null;
  if (blocksKey) await deps.store.putJson(blocksKey, { blocks: article.blocks, sections: article.sections });

  await db.transaction(async (tx) => {
    await tx
      .insert(contentVersion)
      .values({
        itemId: item.id,
        contentHash: article.contentHash,
        blocksKey,
        sectionMap: article.sections,
        rightsSnapshot: snapshot(rights, access),
        excerpt: article.excerpt,
      })
      .onConflictDoNothing();
    await tx
      .update(contentItem)
      .set({
        ...details,
        status: "extracted",
        statusReason: null,
        wordCount: article.wordCount,
        readTimeMinutes: readTimeMinutes(article.wordCount),
        simhash: article.simhash,
      })
      .where(eq(contentItem.id, item.id));
    await tx.update(publisher).set({ extractionsOk: sql`${publisher.extractionsOk} + 1` }).where(eq(publisher.id, item.publisherId));
  });
  return { status: "extracted" as const, reason: null };
}

async function extractVideo(deps: PipelineDeps, item: Item, rights: Rights, ctx: { publisherKey: string }) {
  const videoId = item.externalId!;
  const video = deps.youtube ? await deps.youtube.getVideo(videoId) : null;
  // The channel is the author.
  const authorName = video?.channelTitle || item.creator || null;
  const details = {
    title: item.title ?? video?.title ?? null,
    creator: item.creator ?? video?.channelTitle ?? null,
    publishedAt: item.publishedAt ?? video?.publishedAt ?? null,
    language: null,
    authorName,
    authorKey: video?.channelId ? `youtube:${video.channelId}` : authorName ? authorKeyFor({ name: authorName, publisherKey: ctx.publisherKey }) : null,
    // YouTube serves this size for every public video.
    leadImageUrl: video?.thumbnailUrl ?? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    durationSeconds: video?.durationSeconds ?? null,
  };

  // Native captions only by default (build plan §6.3); generated transcripts are for explicit saves.
  const t = deps.transcripts ? await deps.transcripts.get(videoId) : null;
  if (!isUsableTranscript(t)) return markUnavailable(deps, item, rights, "transcript_missing", details);

  const text = transcriptText(t);
  const wordCount = countWords(text);
  const contentHash = createHash("sha256").update(JSON.stringify(t.segments)).digest("hex");
  const access = decideItemAccess(rights, { unavailableReason: null });
  // Transcripts follow the same gate as article text.
  const key = access.storeBlocks ? contentKeys.transcript(item.id, contentHash) : null;
  if (key) await deps.store.putJson(key, { segments: t.segments });

  await deps.db.transaction(async (tx) => {
    const [version] = await tx
      .insert(contentVersion)
      .values({
        itemId: item.id,
        contentHash,
        blocksKey: null,
        sectionMap: [] satisfies Section[],
        rightsSnapshot: snapshot(rights, access),
        excerpt: video?.description.slice(0, 320) || null,
      })
      .onConflictDoNothing()
      .returning({ id: contentVersion.id });
    if (version && key) {
      await tx.insert(transcript).values({
        itemVersionId: version.id,
        provider: t.provider,
        provenance: t.kind,
        confidence: t.confidence,
        language: t.language,
        key,
      });
    }
    await tx
      .update(contentItem)
      .set({
        ...details,
        // Without the YouTube API, the transcript's end is the best duration we have.
        durationSeconds: details.durationSeconds ?? Math.round(Math.max(...t.segments.map((x) => x.offsetMs + x.durationMs)) / 1000),
        language: t.language,
        status: "extracted",
        statusReason: null,
        wordCount,
        readTimeMinutes: readTimeMinutes(wordCount),
      })
      .where(eq(contentItem.id, item.id));
    await tx.update(publisher).set({ extractionsOk: sql`${publisher.extractionsOk} + 1` }).where(eq(publisher.id, item.publisherId));
  });
  return { status: "extracted" as const, reason: null };
}

/** Metadata only: title, credit and a link, with the reason. Nothing is generated from it. */
async function markUnavailable(
  deps: PipelineDeps,
  item: Item,
  rights: Rights,
  reason: UnavailableReason,
  details: Partial<Pick<Item, "title" | "creator" | "publishedAt" | "language" | "authorName" | "authorKey" | "leadImageUrl" | "durationSeconds">> | null,
) {
  const access = decideItemAccess(rights, { unavailableReason: reason });
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(contentVersion)
      .values({
        itemId: item.id,
        contentHash: `unavailable:${reason}`,
        blocksKey: null,
        sectionMap: [],
        rightsSnapshot: snapshot(rights, access),
        excerpt: null,
      })
      .onConflictDoNothing();
    await tx
      .update(contentItem)
      .set({ ...(details ?? {}), status: "metadata_only", statusReason: reason })
      .where(eq(contentItem.id, item.id));
    // A missing transcript isn't the publisher's extraction failing.
    if (reason !== "transcript_missing") {
      await tx.update(publisher).set({ extractionsFailed: sql`${publisher.extractionsFailed} + 1` }).where(eq(publisher.id, item.publisherId));
    }
  });
  return { status: "metadata_only" as const, reason };
}

async function markDuplicate(deps: PipelineDeps, item: Item, originalId: string, reason: string) {
  await deps.db
    .update(contentItem)
    .set({ status: "failed", statusReason: reason, duplicateOfId: originalId })
    .where(eq(contentItem.id, item.id));
  return { status: "duplicate" as const, reason };
}

function snapshot(rights: Rights, access: ItemAccess) {
  return { ...rights, ...access };
}
