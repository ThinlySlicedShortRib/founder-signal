import { resolveRights } from "@fs/core";
import { addUserSource, type Db, loadRightsRules, schema } from "@fs/db";
import { type DetectDeps, detectSource, SourceDetectionError } from "@fs/ingest";
import { addSourceInputSchema, type SourceView, updateSourceInputSchema } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { contentItem, publisher, source, userSource } = schema;

export interface SourceRouteDeps {
  db: Db;
  detect: DetectDeps;
}

const idParam = z.object({ id: z.uuid() });

/** /me/sources (build plan §7): add, list, change mode/block, remove. Sources are shared; the link is per user. */
export function sourceRoutes({ db, detect }: SourceRouteDeps) {
  return (
    new Hono<AuthedEnv>()
      .use(requireUser)

      .get("/", async (c) => {
        const views = await loadSourceViews(db, c.get("user").id);
        return c.json({ sources: views });
      })

      .post(
        "/",
        zValidator("json", addSourceInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a url and an optional mode");
        }),
        async (c) => {
          const { url, mode } = c.req.valid("json");
          const userId = c.get("user").id;

          let detected;
          try {
            detected = await detectSource(url, detect);
          } catch (err) {
            if (!(err instanceof SourceDetectionError)) throw err;
            const code = err.reason === "invalid_url" ? "VALIDATION_FAILED" : "SOURCE_UNAVAILABLE";
            return apiError(c, 422, code, err.message);
          }

          const sourceId = await addUserSource(db, { userId, mode, detected });

          const [view] = await loadSourceViews(db, userId, [sourceId]);
          return c.json({ source: view! }, 201);
        },
      )

      .patch(
        "/:id",
        zValidator("param", idParam, (result, c) => {
          if (!result.success) return apiError(c, 404, "NOT_FOUND", "Source not found");
        }),
        zValidator("json", updateSourceInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a mode and/or blocked");
        }),
        async (c) => {
          const userId = c.get("user").id;
          const { id } = c.req.valid("param");
          const updated = await db
            .update(userSource)
            .set(c.req.valid("json"))
            .where(and(eq(userSource.userId, userId), eq(userSource.sourceId, id)))
            .returning({ id: userSource.id });
          if (!updated.length) return apiError(c, 404, "NOT_FOUND", "Source not found");
          const [view] = await loadSourceViews(db, userId, [id]);
          return c.json({ source: view! });
        },
      )

      .delete(
        "/:id",
        zValidator("param", idParam, (result, c) => {
          if (!result.success) return apiError(c, 404, "NOT_FOUND", "Source not found");
        }),
        async (c) => {
          const { id } = c.req.valid("param");
          const deleted = await db
            .delete(userSource)
            .where(and(eq(userSource.userId, c.get("user").id), eq(userSource.sourceId, id)))
            .returning({ id: userSource.id });
          if (!deleted.length) return apiError(c, 404, "NOT_FOUND", "Source not found");
          return c.body(null, 204);
        },
      )
  );
}

async function loadSourceViews(db: Db, userId: string, sourceIds?: string[]): Promise<SourceView[]> {
  const where = sourceIds
    ? and(eq(userSource.userId, userId), inArray(userSource.sourceId, sourceIds))
    : eq(userSource.userId, userId);

  const rows = await db
    .select({
      id: source.id,
      type: source.type,
      title: source.title,
      creator: source.creator,
      url: source.inputUrl,
      canonicalKey: source.canonicalKey,
      mode: userSource.mode,
      blocked: userSource.blocked,
      lastFetchStatus: source.lastFetchStatus,
      lastFetchedAt: source.lastFetchedAt,
      publisherId: publisher.id,
      publisherKey: publisher.key,
      publisherName: publisher.name,
      publisherStatus: publisher.status,
      addedAt: userSource.createdAt,
    })
    .from(userSource)
    .innerJoin(source, eq(source.id, userSource.sourceId))
    .innerJoin(publisher, eq(publisher.id, source.publisherId))
    .where(where)
    .orderBy(userSource.createdAt);
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [counts, rules] = await Promise.all([
    db
      .select({ sourceId: contentItem.sourceId, n: count() })
      .from(contentItem)
      .where(inArray(contentItem.sourceId, ids))
      .groupBy(contentItem.sourceId),
    loadRightsRules(db, { publisherKeys: rows.map((r) => r.publisherKey), sourceKeys: rows.map((r) => r.canonicalKey) }),
  ]);
  const countBySource = new Map(counts.map((r) => [r.sourceId, r.n]));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    creator: r.creator,
    url: r.url,
    mode: r.mode,
    blocked: r.blocked,
    publisher: { id: r.publisherId, name: r.publisherName, status: r.publisherStatus },
    rights: resolveRights(rules, { publisherKey: r.publisherKey, sourceKey: r.canonicalKey }),
    lastFetchStatus: r.lastFetchStatus,
    lastFetchedAt: r.lastFetchedAt?.toISOString() ?? null,
    itemCount: countBySource.get(r.id) ?? 0,
  }));
}
