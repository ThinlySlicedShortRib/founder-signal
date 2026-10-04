import { randomUUID } from "node:crypto";
import { schema } from "@fs/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const { contentItem, publisher, source, user, userDiscovery, userPublisher, userSource } = schema;

const ctx = createTestApp();
afterAll(() => ctx.pool.end());

let cookie: string;
let userId: string;
beforeAll(async () => {
  cookie = await signIn(ctx, "publishers@example.com");
  const [u] = await ctx.db.select().from(user).where(eq(user.email, "publishers@example.com"));
  userId = u!.id;
});

const call = (method: string, path: string, body?: unknown) =>
  ctx.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A publisher discovery found for the user, with one linked piece. */
async function discovered(feedUrl: string | null) {
  const key = `found-${randomUUID().slice(0, 8)}.test`;
  const [pub] = await ctx.db.insert(publisher).values({ key, name: "Found Weekly", origin: "discovered", feedUrl }).returning();
  const [item] = await ctx.db.insert(contentItem).values({ canonicalUrl: `https://${key}/post`, type: "article", publisherId: pub!.id }).returning();
  await ctx.db.insert(userDiscovery).values({ userId, itemId: item!.id, reason: "A first-hand account" });
  return pub!;
}

describe("/me/publishers", () => {
  it("requires sign-in", async () => {
    expect((await ctx.app.request(`${BASE_URL}/me/publishers`)).status).toBe(401);
  });

  it("lists publishers discovery found for the user", async () => {
    const pub = await discovered(null);
    const res = await call("GET", "/me/publishers");
    expect(res.status).toBe(200);
    const { publishers } = (await res.json()) as { publishers: Record<string, unknown>[] };
    expect(publishers.find((p) => p.id === pub.id)).toMatchObject({
      name: "Found Weekly",
      status: "candidate",
      origin: "discovered",
      followable: false,
      following: false,
      blocked: false,
      found: 1,
    });
  });

  it("follows a publisher's feed as a source, and unfollows it", async () => {
    const feedUrl = `https://feeds-${randomUUID().slice(0, 6)}.test/rss`;
    const pub = await discovered(feedUrl);
    const res = await call("PATCH", `/me/publishers/${pub.id}`, { following: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { publisher: unknown }).publisher).toMatchObject({ followable: true, following: true });
    const [src] = await ctx.db.select().from(source).where(eq(source.publisherId, pub.id));
    expect(src).toMatchObject({ type: "feed", fetchUrl: feedUrl });
    // The publisher keeps its catalog origin.
    expect((await ctx.db.select().from(publisher).where(eq(publisher.id, pub.id)))[0]!.origin).toBe("discovered");

    const off = await call("PATCH", `/me/publishers/${pub.id}`, { following: false });
    expect(((await off.json()) as { publisher: unknown }).publisher).toMatchObject({ following: false });
    expect(await ctx.db.select().from(userSource).where(and(eq(userSource.userId, userId), eq(userSource.sourceId, src!.id)))).toEqual([]);
  });

  it("can't follow a publisher without a feed", async () => {
    const pub = await discovered(null);
    const res = await call("PATCH", `/me/publishers/${pub.id}`, { following: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  });

  it("blocks and unblocks a publisher for this user, as their own choice", async () => {
    const pub = await discovered(null);
    const res = await call("PATCH", `/me/publishers/${pub.id}`, { blocked: true });
    expect(((await res.json()) as { publisher: unknown }).publisher).toMatchObject({ blocked: true, status: "candidate" });
    const [row] = await ctx.db.select().from(userPublisher).where(and(eq(userPublisher.userId, userId), eq(userPublisher.publisherId, pub.id)));
    expect(row).toMatchObject({ blocked: true, blockedReason: "user" });

    await call("PATCH", `/me/publishers/${pub.id}`, { blocked: false });
    const [after] = await ctx.db.select().from(userPublisher).where(eq(userPublisher.id, row!.id));
    expect(after).toMatchObject({ blocked: false, blockedReason: "user" });
  });

  it("validates input and unknown publishers", async () => {
    const pub = await discovered(null);
    expect((await call("PATCH", `/me/publishers/${pub.id}`, {})).status).toBe(400);
    expect((await call("PATCH", `/me/publishers/${randomUUID()}`, { blocked: true })).status).toBe(404);
    expect((await call("PATCH", "/me/publishers/not-a-uuid", { blocked: true })).status).toBe(404);
  });
});
