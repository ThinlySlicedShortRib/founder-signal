import { schema } from "@fs/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const ctx = createTestApp();
afterAll(() => ctx.pool.end());

const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Indie Hackers Weekly</title>
<link>https://indie.example.com/</link><item><title>One</title><link>https://indie.example.com/one</link></item></channel></rss>`;
const home = `<!doctype html><html><head><title>Indie Hackers Weekly</title>
<meta property="og:site_name" content="Indie Hackers Weekly">
<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Home</body></html>`;
const article = `<!doctype html><html><head><title>A single essay</title><meta property="og:type" content="article"></head>
<body><article><p>${"Words about pricing and customers. ".repeat(80)}</p></article></body></html>`;

ctx.web.set("https://indie.example.com/", { body: home });
ctx.web.set("https://indie.example.com/feed.xml", { contentType: "application/rss+xml", body: feed });
ctx.web.set("https://essays.example.org/pricing", { body: article });

let cookie: string;
let otherCookie: string;
beforeAll(async () => {
  cookie = await signIn(ctx, "sources@example.com");
  otherCookie = await signIn(ctx, "other-sources@example.com");
});

const call = (method: string, path: string, body?: unknown, as = cookie) =>
  ctx.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/me/sources", () => {
  it("requires sign-in", async () => {
    const res = await ctx.app.request(`${BASE_URL}/me/sources`);
    expect(res.status).toBe(401);
  });

  it("adds a site by its homepage, following its feed, with personal-use rights", async () => {
    const res = await call("POST", "/me/sources", { url: "indie.example.com", mode: "follow_closely" });
    expect(res.status).toBe(201);
    const { source } = (await res.json()) as { source: Record<string, unknown> };
    expect(source).toMatchObject({
      type: "feed",
      title: "Indie Hackers Weekly",
      mode: "follow_closely",
      blocked: false,
      publisher: { name: "Indie Hackers Weekly", status: "candidate" },
      rights: { display: "full_text", retainText: true, offlineAllowed: true },
      itemCount: 0,
      lastFetchStatus: null,
    });

    const [row] = await ctx.db.select().from(schema.source).where(eq(schema.source.id, source.id as string));
    expect(row).toMatchObject({ canonicalKey: "https://indie.example.com/feed.xml", fetchUrl: "https://indie.example.com/feed.xml" });
    // Due immediately, so the next sweep fetches it.
    expect(row!.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("shares one source between users but keeps the link per user", async () => {
    const mine = (await (await call("POST", "/me/sources", { url: "https://indie.example.com/feed.xml" })).json()) as {
      source: { id: string; mode: string };
    };
    const theirs = (await (await call("POST", "/me/sources", { url: "https://indie.example.com/" }, otherCookie)).json()) as {
      source: { id: string; mode: string };
    };
    expect(theirs.source.id).toBe(mine.source.id);
    // Re-adding updates the mode.
    expect(mine.source.mode).toBe("more_like_this");
    const sources = await ctx.db.select().from(schema.source).where(eq(schema.source.canonicalKey, "https://indie.example.com/feed.xml"));
    expect(sources).toHaveLength(1);
  });

  it("adds a single article as a one-off URL", async () => {
    const res = await call("POST", "/me/sources", { url: "https://essays.example.org/pricing?utm_source=newsletter" });
    expect(res.status).toBe(201);
    const { source } = (await res.json()) as { source: { type: string; publisher: { name: string } } };
    expect(source).toMatchObject({ type: "url", publisher: { name: "essays.example.org" } });
  });

  it("adds a YouTube channel", async () => {
    const res = await call("POST", "/me/sources", { url: "https://www.youtube.com/@founderstalk" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source: { type: "youtube_channel", title: "Founders Talk" } });
  });

  it("applies a tighter rights rule when one exists", async () => {
    await ctx.db.insert(schema.rightsRule).values({
      scope: "domain",
      scopeKey: "essays.example.org",
      display: "excerpt_only",
      retainText: true,
      offlineAllowed: false,
    });
    const { sources } = (await (await call("GET", "/me/sources")).json()) as {
      sources: { type: string; rights: Record<string, unknown> }[];
    };
    expect(sources.find((s) => s.type === "url")?.rights).toMatchObject({ display: "excerpt_only", offlineAllowed: false });
    expect(sources.find((s) => s.type === "feed")?.rights).toMatchObject({ display: "full_text" });
  });

  it("explains links it can't use", async () => {
    const unreachable = await call("POST", "/me/sources", { url: "https://nowhere.example.net/" });
    expect(unreachable.status).toBe(422);
    expect(await unreachable.json()).toMatchObject({ code: "SOURCE_UNAVAILABLE" });

    const invalid = await call("POST", "/me/sources", { url: "javascript:alert(1)" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION_FAILED" });

    const missing = await call("POST", "/me/sources", {});
    expect(missing.status).toBe(400);
  });

  it("lists only my sources", async () => {
    const mine = (await (await call("GET", "/me/sources")).json()) as { sources: unknown[] };
    const theirs = (await (await call("GET", "/me/sources", undefined, otherCookie)).json()) as { sources: unknown[] };
    expect(mine.sources).toHaveLength(3);
    expect(theirs.sources).toHaveLength(1);
  });

  it("changes mode and blocks, and removes", async () => {
    const { sources } = (await (await call("GET", "/me/sources")).json()) as { sources: { id: string; type: string }[] };
    const id = sources.find((s) => s.type === "youtube_channel")!.id;

    const patched = await call("PATCH", `/me/sources/${id}`, { mode: "occasional", blocked: true });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ source: { mode: "occasional", blocked: true } });

    expect((await call("PATCH", `/me/sources/${id}`, {})).status).toBe(400);
    // Someone else can't touch my link.
    expect((await call("PATCH", `/me/sources/${id}`, { mode: "occasional" }, otherCookie)).status).toBe(404);
    expect((await call("DELETE", `/me/sources/${id}`, undefined, otherCookie)).status).toBe(404);

    expect((await call("DELETE", `/me/sources/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/me/sources/${id}`)).status).toBe(404);
    expect((await call("PATCH", "/me/sources/not-a-uuid", { mode: "occasional" })).status).toBe(404);
  });
});
