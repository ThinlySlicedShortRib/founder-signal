import { type Embedder, embeddingText, type EnrichmentBatches, type EnrichmentInput } from "@fs/ai";
import { schema } from "@fs/db";
import { blocksToText, type TranscriptSegment, transcriptText } from "@fs/ingest";
import type { Block } from "@fs/schema";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "./deps.ts";
import type { Message } from "./messages.ts";

const { contentItem, contentVersion, enrichmentBatch, publisher, transcript } = schema;

export interface Enricher {
  batches: EnrichmentBatches;
  embedder: Embedder;
}

const MAX_ITEMS_PER_BATCH = 100;
/** After this many failed attempts an item stays `extracted` and out of letters. */
export const MAX_ENRICHMENT_ATTEMPTS = 3;

export async function enrich(deps: PipelineDeps, message: Message<"enrich">) {
  if (!deps.enricher) return { status: "disabled" as const };
  return message.kind === "submit" ? submitBatch(deps, deps.enricher) : applyBatch(deps, deps.enricher, message.batchId);
}

/** Claims extracted items and submits them as one Message Batch. */
async function submitBatch(deps: PipelineDeps, enricher: Enricher) {
  const log = logger(deps);
  return deps.db.transaction(async (tx) => {
    const items = await tx
      .select({ id: contentItem.id, type: contentItem.type, title: contentItem.title, publisherName: publisher.name })
      .from(contentItem)
      .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
      .where(
        and(
          eq(contentItem.status, "extracted"),
          isNull(contentItem.enrichmentBatchId),
          isNull(contentItem.duplicateOfId),
          lt(contentItem.enrichmentAttempts, MAX_ENRICHMENT_ATTEMPTS),
        ),
      )
      .orderBy(contentItem.createdAt)
      .limit(MAX_ITEMS_PER_BATCH)
      .for("update", { of: contentItem, skipLocked: true });
    if (!items.length) return { status: "nothing_to_do" as const };

    const inputs: EnrichmentInput[] = [];
    for (const item of items) {
      inputs.push({ itemId: item.id, title: item.title, publisher: item.publisherName, type: item.type, text: await loadItemText(deps, item.id) });
    }

    const { providerBatchId } = await enricher.batches.submit(inputs);
    const [batch] = await tx
      .insert(enrichmentBatch)
      .values({ providerBatchId, itemCount: items.length, model: enricher.batches.model, promptVersion: enricher.batches.promptVersion })
      .returning({ id: enrichmentBatch.id });
    await tx
      .update(contentItem)
      .set({ enrichmentBatchId: batch!.id, enrichmentAttempts: sql`${contentItem.enrichmentAttempts} + 1` })
      .where(inArray(contentItem.id, items.map((i) => i.id)));

    log("enrich_submit", { batchId: batch!.id, providerBatchId, items: items.length });
    return { status: "submitted" as const, batchId: batch!.id, items: items.length };
  });
}

/** Applies a finished batch: enrichment fields plus an embedding per item. Safe to re-run. */
async function applyBatch(deps: PipelineDeps, enricher: Enricher, batchId: string) {
  const { db } = deps;
  const log = logger(deps);

  const [batch] = await db.select().from(enrichmentBatch).where(eq(enrichmentBatch.id, batchId));
  if (!batch || batch.status !== "submitted") return { status: "skipped" as const };

  const results = await enricher.batches.results(batch.providerBatchId);
  if (!results) return { status: "processing" as const };

  let enriched = 0;
  let failed = 0;
  for (const result of results) {
    // Only items still waiting on this batch; a re-run skips the ones already applied.
    const [item] = await db
      .select({ id: contentItem.id, title: contentItem.title, attempts: contentItem.enrichmentAttempts })
      .from(contentItem)
      .where(and(eq(contentItem.id, result.itemId), eq(contentItem.enrichmentBatchId, batchId), eq(contentItem.status, "extracted")));
    if (!item) continue;

    if (!result.ok) {
      failed++;
      const retry = result.retryable && item.attempts < MAX_ENRICHMENT_ATTEMPTS;
      await db
        .update(contentItem)
        .set(retry ? { enrichmentBatchId: null } : { statusReason: `enrichment_failed:${result.error}` })
        .where(eq(contentItem.id, item.id));
      continue;
    }

    const { tags, language, depth, quality, icon } = result.enrichment;
    const embedding = await enricher.embedder.embed(embeddingText({ title: item.title, tags, text: await loadItemText(deps, item.id) }));
    await db
      .update(contentItem)
      .set({
        tags,
        // Extraction's <html lang> wins when present; the model fills the gaps.
        language: sql`coalesce(${contentItem.language}, ${language})`,
        depth,
        qualityLabel: quality,
        icon,
        embedding,
        status: "enriched",
        enrichedAt: new Date(),
      })
      .where(eq(contentItem.id, item.id));
    enriched++;
  }

  // Items the batch didn't return (shouldn't happen) go back in the queue.
  await db
    .update(contentItem)
    .set({ enrichmentBatchId: null })
    .where(and(eq(contentItem.enrichmentBatchId, batchId), eq(contentItem.status, "extracted"), isNull(contentItem.statusReason)));
  await db.update(enrichmentBatch).set({ status: "applied", completedAt: new Date() }).where(eq(enrichmentBatch.id, batchId));

  log("enrich_apply", { batchId, enriched, failed });
  return { status: "applied" as const, enriched, failed };
}

/** The best text we kept for an item: its blocks, its transcript, or at least its excerpt. */
export async function loadItemText(deps: PipelineDeps, itemId: string): Promise<string> {
  const [version] = await deps.db
    .select({ id: contentVersion.id, blocksKey: contentVersion.blocksKey, excerpt: contentVersion.excerpt, transcriptKey: transcript.key })
    .from(contentVersion)
    .leftJoin(transcript, eq(transcript.itemVersionId, contentVersion.id))
    .where(eq(contentVersion.itemId, itemId))
    .orderBy(desc(contentVersion.fetchedAt))
    .limit(1);
  if (!version) return "";
  if (version.blocksKey) {
    const stored = await deps.store.getJson<{ blocks: Block[] }>(version.blocksKey);
    if (stored) return blocksToText(stored.blocks);
  }
  if (version.transcriptKey) {
    const stored = await deps.store.getJson<{ segments: TranscriptSegment[] }>(version.transcriptKey);
    if (stored) return transcriptText({ segments: stored.segments });
  }
  return version.excerpt ?? "";
}
