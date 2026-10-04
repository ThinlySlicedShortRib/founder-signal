import { addUserSource, type Db, schema } from "@fs/db";
import { canonicalizeUrl } from "@fs/ingest";
import { type PublisherView, updatePublisherInputSchema } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { contentItem, publisher, source, userDiscovery, userPublisher, userSource } = schema;

const idParam = z.object({ id: z.uuid() });

/**
 * /me/publishers (build plan §7, §6.3a): the publishers discovery found for
 * the user, and ones they blocked. Following one adds its feed as a source;
 * blocking one keeps it out of their searches and letters. Both are per user;
 * the catalog itself is shared.
 */
export function publisherRoutes({ db }: { db: Db }) {
  return (
    new Hono<AuthedEnv>()
      .use(requireUser)

      .get("/", async (c) => c.json({ publishers: await loadPublisherViews(db, c.get("user").id) }))

      .patch(
        "/:id",
        zValidator("param", idParam, (result, c) => {
          if (!result.success) return apiError(c, 404, "NOT_FOUND", "Publisher not found");
        }),
        zValidator("json", updatePublisherInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send following and/or blocked");
        }),
        async (c) => {
          const userId = c.get("user").id;
          const { id } = c.req.valid("param");
          const { following, blocked } = c.req.valid("json");
          const [pub] = await db.select().from(publisher).where(eq(publisher.id, id));
          if (!pub) return apiError(c, 404, "NOT_FOUND", "Publisher not found");

          if (following === true) {
            if (!pub.feedUrl) return apiError(c, 422, "SOURCE_UNAVAILABLE", "We couldn't find a feed to follow for this publisher");
            await addUserSource(db, {
              userId,
              mode: "more_like_this",
              detected: {
                type: "feed",
                canonicalKey: canonicalizeUrl(pub.feedUrl),
                inputUrl: pub.feedUrl,
                fetchUrl: pub.feedUrl,
                title: pub.name,
                creator: null,
                publisher: { key: pub.key, name: pub.name, feedUrl: pub.feedUrl },
              },
            });
          } else if (following === false) {
            const sources = db.select({ id: source.id }).from(source).where(eq(source.publisherId, id));
            await db.delete(userSource).where(and(eq(userSource.userId, userId), inArray(userSource.sourceId, sources)));
          }

          if (blocked !== undefined) {
            // The user's own choice; the vote rules never override it (blocked_reason = 'user').
            const values = { blocked, blockedReason: "user", blockedAt: blocked ? new Date() : null };
            await db
              .insert(userPublisher)
              .values({ userId, publisherId: id, ...values })
              .onConflictDoUpdate({ target: [userPublisher.userId, userPublisher.publisherId], set: values });
          }

          const [view] = await loadPublisherViews(db, userId, [id]);
          return c.json({ publisher: view! });
        },
      )
  );
}

async function loadPublisherViews(db: Db, userId: string, ids?: string[]): Promise<PublisherView[]> {
  const found = db
    .select({
      publisherId: contentItem.publisherId,
      found: sql<number>`count(*)::int`.as("found"),
      lastFoundAt: sql<Date>`max(${userDiscovery.foundAt})`.as("last_found_at"),
    })
    .from(userDiscovery)
    .innerJoin(contentItem, eq(contentItem.id, userDiscovery.itemId))
    .where(eq(userDiscovery.userId, userId))
    .groupBy(contentItem.publisherId)
    .as("found");

  const rows = await db
    .select({
      publisher,
      found: found.found,
      lastFoundAt: found.lastFoundAt,
      blocked: userPublisher.blocked,
      following: sql<boolean>`exists(
        select 1 from ${userSource} join ${source} on ${source.id} = ${userSource.sourceId}
        where ${userSource.userId} = ${userId} and ${source.publisherId} = ${publisher.id} and not ${userSource.blocked})`,
    })
    .from(publisher)
    .leftJoin(found, eq(found.publisherId, publisher.id))
    .leftJoin(userPublisher, and(eq(userPublisher.publisherId, publisher.id), eq(userPublisher.userId, userId)))
    .where(
      ids
        ? inArray(publisher.id, ids)
        : sql`(${found.publisherId} is not null or ${userPublisher.id} is not null)`,
    )
    .orderBy(desc(sql`coalesce(${found.lastFoundAt}, ${userPublisher.updatedAt})`));

  return rows.map((r) => ({
    id: r.publisher.id,
    name: r.publisher.name,
    key: r.publisher.key,
    status: r.publisher.status,
    origin: r.publisher.origin,
    followable: !!r.publisher.feedUrl,
    following: r.following,
    blocked: r.blocked ?? false,
    found: r.found ?? 0,
    lastFoundAt: r.lastFoundAt ? new Date(r.lastFoundAt).toISOString() : null,
  }));
}
