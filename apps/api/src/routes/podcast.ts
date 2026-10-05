import { type Db, findEpisode, requestEpisode, schema } from "@fs/db";
import type { Rights } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { episodeView, type PodcastConfig } from "../lib/podcast.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { contentItem, contentVersion } = schema;

export interface PodcastRouteDeps {
  db: Db;
  /** Null: episodes are off (PODCAST_TTS=none). */
  podcast: PodcastConfig | null;
}

const idParam = z.object({ id: z.uuid() });
const itemNotFound = (r: { success: boolean }, c: Parameters<typeof apiError>[0]) => {
  if (!r.success) return apiError(c, 404, "NOT_FOUND", "Item not found");
};

/** An episode retells the whole piece, so only articles the app may show in full get one. */
async function canHaveEpisode(db: Db, itemId: string): Promise<"ok" | "not_found" | "unlicensed"> {
  const [row] = await db
    .select({ type: contentItem.type, rights: contentVersion.rightsSnapshot, blocksKey: contentVersion.blocksKey })
    .from(contentItem)
    .innerJoin(contentVersion, eq(contentVersion.itemId, contentItem.id))
    .where(eq(contentItem.id, itemId))
    .orderBy(desc(contentVersion.fetchedAt))
    .limit(1);
  if (!row) return "not_found";
  const rights = row.rights as Rights;
  return row.type === "article" && rights.display === "full_text" && rights.retainText && row.blocksKey ? "ok" : "unlicensed";
}

/**
 * /items/:id/episode (the podcast experiment): GET says whether there's one
 * and how far along it is; POST asks for it. Episodes are shared, so asking
 * for one someone else asked for returns theirs.
 */
export function episodeRoutes({ db, podcast }: PodcastRouteDeps) {
  // Each new episode is a model call and a minute or two of a worker; this keeps a stuck client in check.
  const limiter = createRateLimiter({ limit: 20, windowMs: 60 * 60_000 });

  return new Hono<AuthedEnv>()
    .use(requireUser)
    .get("/:id/episode", zValidator("param", idParam, itemNotFound), async (c) => {
      if (!podcast) return c.json({ episode: null, available: false });
      const itemId = c.req.valid("param").id;
      const access = await canHaveEpisode(db, itemId);
      if (access === "not_found") return apiError(c, 404, "NOT_FOUND", "Item not found");
      const row = await findEpisode(db, { itemId, format: podcast.format, promptVersion: podcast.promptVersion, voiceKey: podcast.voiceKey });
      return c.json({ episode: row ? episodeView(row, podcast.audioUrl) : null, available: access === "ok" });
    })
    .post("/:id/episode", zValidator("param", idParam, itemNotFound), async (c) => {
      if (!podcast) return apiError(c, 422, "VALIDATION_FAILED", "Episodes are off");
      const userId = c.get("user").id;
      const itemId = c.req.valid("param").id;
      const access = await canHaveEpisode(db, itemId);
      if (access === "not_found") return apiError(c, 404, "NOT_FOUND", "Item not found");
      if (access === "unlicensed") return apiError(c, 422, "FULL_TEXT_UNLICENSED", "This piece can't be made into an episode");
      if (!limiter(userId)) return apiError(c, 429, "RATE_LIMITED", "Too many episodes asked for; try again later");

      const out = await requestEpisode(db, { itemId, format: podcast.format, promptVersion: podcast.promptVersion, voiceKey: podcast.voiceKey, userId });
      if (!out) return apiError(c, 404, "NOT_FOUND", "Item not found");
      if (out.queued && podcast.queue) {
        // If this send is lost, asking again after a while sends it again (see requestEpisode).
        await podcast.queue.start(out.episode.id).catch((err: Error) => {
          console.warn(JSON.stringify({ level: "warn", message: "couldn't queue an episode", error: err.message }));
        });
      }
      return c.json({ episode: episodeView(out.episode, podcast.audioUrl) }, out.queued ? 202 : 200);
    });
}
