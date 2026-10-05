import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { contentVersion } from "../schema/ingestion.ts";
import { episode } from "../schema/podcast.ts";

export type EpisodeRow = typeof episode.$inferSelect;

/** What makes an episode the same one: the piece's latest version plus these. */
export interface EpisodeIdentity {
  itemId: string;
  format: string;
  promptVersion: string;
  voiceKey: string;
}

/** A queued episode whose message may have been lost is sent again after this long. */
const RESEND_AFTER_MS = 10 * 60_000;

async function latestVersionId(db: Db, itemId: string): Promise<string | null> {
  const [v] = await db
    .select({ id: contentVersion.id })
    .from(contentVersion)
    .where(eq(contentVersion.itemId, itemId))
    .orderBy(desc(contentVersion.fetchedAt))
    .limit(1);
  return v?.id ?? null;
}

const sameEpisode = (versionId: string, id: EpisodeIdentity) =>
  and(eq(episode.itemVersionId, versionId), eq(episode.format, id.format), eq(episode.promptVersion, id.promptVersion), eq(episode.voiceKey, id.voiceKey));

/** The episode for the piece as it reads now, if one was ever asked for. */
export async function findEpisode(db: Db, id: EpisodeIdentity): Promise<EpisodeRow | null> {
  const versionId = await latestVersionId(db, id.itemId);
  if (!versionId) return null;
  const [row] = await db.select().from(episode).where(sameEpisode(versionId, id));
  return row ?? null;
}

/**
 * Asks for an episode of the piece as it reads now. Episodes are shared, so
 * this returns the existing one when there is one; a failed one is queued
 * again. `queued` says whether the caller should send it to the workers
 * (also when an old queued one looks like its message was lost). Null when
 * the item has no extracted version.
 */
export async function requestEpisode(
  db: Db,
  id: EpisodeIdentity & { userId: string | null },
  now: Date = new Date(),
): Promise<{ episode: EpisodeRow; queued: boolean } | null> {
  const versionId = await latestVersionId(db, id.itemId);
  if (!versionId) return null;
  const [created] = await db
    .insert(episode)
    .values({ itemId: id.itemId, itemVersionId: versionId, format: id.format, promptVersion: id.promptVersion, voiceKey: id.voiceKey, requestedBy: id.userId })
    .onConflictDoNothing()
    .returning();
  if (created) return { episode: created, queued: true };

  const [requeued] = await db
    .update(episode)
    .set({ status: "queued", error: null, startedAt: null })
    .where(and(sameEpisode(versionId, id), eq(episode.status, "failed")))
    .returning();
  if (requeued) return { episode: requeued, queued: true };

  const [existing] = await db.select().from(episode).where(sameEpisode(versionId, id));
  if (!existing) return null;
  const stale = existing.status === "queued" && now.getTime() - existing.updatedAt.getTime() > RESEND_AFTER_MS;
  if (stale) await db.update(episode).set({ updatedAt: sql`now()` }).where(eq(episode.id, existing.id));
  return { episode: existing, queued: stale };
}
