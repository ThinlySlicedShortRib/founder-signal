import { createHash } from "node:crypto";
import { schema } from "@fs/db";
import { foundFeed, foundSite } from "@fs/ingest";
import type { ConfirmImportResult, ImportView } from "@fs/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createImport } from "../src/routes/imports.ts";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

// ── A fake Google: token endpoint, subscriptions, revoke ────────────────────

const REDIRECT = `${BASE_URL}/connections/youtube/callback`;
const google = {
  /** The PKCE challenge from the last consent URL, keyed by the code Google "issues". */
  challenges: new Map<string, string>(),
  revoked: [] as string[],
  subscriptionCalls: 0,
};
const channel = (n: number) => `UC${String(n).padStart(22, "0")}`;
const googleFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === "/token") {
    const body = new URLSearchParams(String(init?.body));
    const challenge = google.challenges.get(body.get("code") ?? "");
    const verifier = body.get("code_verifier") ?? "";
    const ok =
      challenge === createHash("sha256").update(verifier).digest("base64url") &&
      body.get("client_secret") === "test-secret" &&
      body.get("redirect_uri") === REDIRECT &&
      body.get("grant_type") === "authorization_code";
    if (!ok) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "access-1", scope: "https://www.googleapis.com/auth/youtube.readonly", expires_in: 3599 });
  }
  if (url.pathname === "/revoke") {
    google.revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
    return new Response(null, { status: 200 });
  }
  if (url.pathname === "/youtube/v3/subscriptions") {
    google.subscriptionCalls++;
    if (new Headers(init?.headers).get("authorization") !== "Bearer access-1") return Response.json({}, { status: 401 });
    const page = url.searchParams.get("pageToken");
    return Response.json(
      page
        ? { items: [{ snippet: { title: "Channel Three", resourceId: { kind: "youtube#channel", channelId: channel(3) } } }] }
        : {
            nextPageToken: "next",
            items: [
              { snippet: { title: "Channel One", resourceId: { kind: "youtube#channel", channelId: channel(1) } } },
              { snippet: { title: "Channel Two", resourceId: { kind: "youtube#channel", channelId: channel(2) } } },
            ],
          },
    );
  }
  return new Response("not found", { status: 404 });
}) as typeof globalThis.fetch;

const ctx = createTestApp();
const yt = createTestApp({
  youtubeConnect: {
    config: { clientId: "test-client", clientSecret: "test-secret", redirectUrl: REDIRECT },
    google: { fetch: googleFetch, tokenUrl: "https://google.test/token", revokeUrl: "https://google.test/revoke", apiBaseUrl: "https://google.test/youtube/v3" },
  },
});
afterAll(async () => {
  await ctx.pool.end();
  await yt.pool.end();
});

const rss = (title: string, site: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${site}</link><item><title>One</title><link>${site}one</link></item></channel></rss>`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

ctx.web.set("https://followed.example.com/feed.xml", { contentType: "application/rss+xml", body: rss("Followed", "https://followed.example.com/") });
ctx.web.set("https://linked.example.com/", { body: '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head></html>' });
ctx.web.set("https://late.example.org/", { body: '<html><head><title>Late</title><link rel="alternate" type="application/rss+xml" href="/rss"></head></html>' });
ctx.web.set("https://late.example.org/rss", { contentType: "application/rss+xml", body: rss("Late Site", "https://late.example.org/") });
ctx.web.set("https://nofeed.example.org/", { body: "<html><head><title>No feed</title></head><body>hi</body></html>" });

const OPML = `<?xml version="1.0"?>
<opml version="2.0"><head><title>My reader</title></head><body>
  <outline text="Founders">
    <outline type="rss" text="Followed already" xmlUrl="http://followed.example.com/feed.xml" htmlUrl="https://followed.example.com/"/>
    <outline type="rss" text="New one" xmlUrl="https://new.example.com/rss" htmlUrl="https://new.example.com/"/>
  </outline>
  <outline type="rss" text="Another" xmlUrl="https://another.example.net/feed"/>
  <outline type="rss" text="Duplicate" xmlUrl="https://another.example.net/feed/"/>
  <outline text="Linked site" htmlUrl="https://linked.example.com/"/>
  <outline text="Empty"/>
</body></opml>`;

let cookie: string;
let otherCookie: string;
let ytCookie: string;
let ytOtherCookie: string;
beforeAll(async () => {
  cookie = await signIn(ctx, "imports@example.com");
  otherCookie = await signIn(ctx, "other-imports@example.com");
  ytCookie = await signIn(yt, "youtube-imports@example.com");
  ytOtherCookie = await signIn(yt, "youtube-other@example.com");
});

const call = (app: typeof ctx, method: string, path: string, body: unknown, as: string) =>
  app.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/me/imports", () => {
  it("requires sign-in", async () => {
    expect((await ctx.app.request(`${BASE_URL}/me/imports`)).status).toBe(401);
    expect((await ctx.app.request(`${BASE_URL}/me/imports/opml`, { method: "POST" })).status).toBe(401);
  });

  let importView: ImportView;

  it("lists an OPML file's feeds as a checklist: deduped, folders kept, followed ones marked, sites resolved", async () => {
    expect((await call(ctx, "POST", "/me/sources", { url: "https://followed.example.com/feed.xml" }, cookie)).status).toBe(201);

    const res = await call(ctx, "POST", "/me/imports/opml", { opml: OPML, filename: "feedly.opml" }, cookie);
    expect(res.status).toBe(201);
    importView = ((await res.json()) as { import: ImportView }).import;
    expect(importView).toMatchObject({ method: "opml", label: "feedly.opml", addedCount: 0 });
    expect(importView.notes).toEqual(["1 entry had no link to follow."]);
    expect(importView.candidates.map((c) => [c.title, c.group, c.url, c.check, c.following])).toEqual([
      // Exported as http://, followed as https://: still recognised.
      ["Followed already", "Founders", "http://followed.example.com/feed.xml", "ready", true],
      ["New one", "Founders", "https://new.example.com/rss", "ready", false],
      ["Another", null, "https://another.example.net/feed", "ready", false],
      ["Linked site", null, "https://linked.example.com/feed", "ready", false],
    ]);
  });

  it("adds only what was picked, with the chosen mode, due now, remembering the import", async () => {
    const pick = importView.candidates.filter((c) => c.title === "New one" || c.title === "Followed already").map((c) => c.key);
    const res = await call(ctx, "POST", `/me/imports/${importView.id}/confirm`, { keys: [...pick, "https://not-in-this-import.example.com/feed"], mode: "follow_closely" }, cookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as ConfirmImportResult).toEqual({ added: 1, alreadyFollowing: 1, failed: [] });

    const { sources } = (await (await call(ctx, "GET", "/me/sources", undefined, cookie)).json()) as { sources: { title: string; mode: string }[] };
    expect(sources.map((s) => [s.title, s.mode])).toEqual([
      ["Followed", "more_like_this"], // Left exactly as it was.
      ["New one", "follow_closely"],
    ]);

    const [row] = await ctx.db
      .select({ importId: schema.userSource.importId, nextFetchAt: schema.source.nextFetchAt, fetchUrl: schema.source.fetchUrl, type: schema.source.type })
      .from(schema.userSource)
      .innerJoin(schema.source, eq(schema.source.id, schema.userSource.sourceId))
      .where(eq(schema.source.canonicalKey, "https://new.example.com/rss"));
    expect(row).toMatchObject({ importId: importView.id, fetchUrl: "https://new.example.com/rss", type: "feed" });
    expect(row!.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // The http:// export reused the existing https source instead of making a second one.
    const followed = await ctx.db.select().from(schema.source).where(eq(schema.source.title, "Followed already"));
    expect(followed).toHaveLength(0);

    const again = (await (await call(ctx, "GET", `/me/imports/${importView.id}`, undefined, cookie)).json()) as { import: ImportView };
    expect(again.import.addedCount).toBe(1);
    expect(again.import.candidates.find((c) => c.title === "New one")?.following).toBe(true);
  });

  it("keeps imports private to their owner", async () => {
    expect((await call(ctx, "GET", `/me/imports/${importView.id}`, undefined, otherCookie)).status).toBe(404);
    const steal = await call(ctx, "POST", `/me/imports/${importView.id}/confirm`, { keys: [importView.candidates[2]!.key] }, otherCookie);
    expect(steal.status).toBe(404);
    expect((await call(ctx, "GET", "/me/imports/not-a-uuid", undefined, cookie)).status).toBe(404);
    const list = (await (await call(ctx, "GET", "/me/imports", undefined, otherCookie)).json()) as { imports: unknown[]; youtube: { configured: boolean } };
    expect(list).toEqual({ imports: [], youtube: { configured: false } });
  });

  it("refuses picks from outside the import and empty picks", async () => {
    expect((await call(ctx, "POST", `/me/imports/${importView.id}/confirm`, { keys: ["https://evil.example.com/feed"] }, cookie)).status).toBe(400);
    expect((await call(ctx, "POST", `/me/imports/${importView.id}/confirm`, { keys: [] }, cookie)).status).toBe(400);
  });

  it("looks for a website's feed when it's added, and reports the ones without", async () => {
    const userId = (await ctx.db.select().from(schema.user).where(eq(schema.user.email, "imports@example.com")))[0]!.id;
    const view = await createImport(ctx.db, {
      userId,
      method: "opml",
      label: "sites",
      found: [foundSite("https://late.example.org/", { title: "Late" }), foundSite("https://nofeed.example.org/", { title: "No feed" }), foundFeed("https://x.example.com/f", { title: "X" })],
      notes: [],
    });
    expect(view.candidates.map((c) => c.check)).toEqual(["site", "site", "ready"]);
    const res = await call(ctx, "POST", `/me/imports/${view.id}/confirm`, { keys: view.candidates.slice(0, 2).map((c) => c.key) }, cookie);
    expect(await res.json()).toEqual({
      added: 1,
      alreadyFollowing: 0,
      failed: [{ key: view.candidates[1]!.key, title: "No feed", message: "No feed found on that site" }],
    });
    const [late] = await ctx.db.select().from(schema.source).where(eq(schema.source.canonicalKey, "https://late.example.org/rss"));
    expect(late).toMatchObject({ type: "feed", title: "Late Site" });
  });

  it("explains files that aren't OPML and refuses huge ones", async () => {
    const bad = await call(ctx, "POST", "/me/imports/opml", { opml: "<html>nope</html>" }, cookie);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringMatching(/isn't OPML/) });
    const bomb = await call(ctx, "POST", "/me/imports/opml", { opml: '<!DOCTYPE x [<!ENTITY a "aaaa">]><opml><body/></opml>' }, cookie);
    expect(bomb.status).toBe(422);
    const huge = await call(ctx, "POST", "/me/imports/opml", { opml: `<opml><body>${"x".repeat(3 * 1024 * 1024)}</body></opml>` }, cookie);
    expect([400, 413]).toContain(huge.status);
  });

  it("imports a Bluesky account's follows (and their websites' feeds)", async () => {
    const api = "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows";
    ctx.web.set(`${api}?actor=founder.bsky.social&limit=100`, json({
      subject: { handle: "founder.bsky.social" },
      follows: [
        { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "writer.example.com", displayName: "A Writer" },
        { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb", handle: "b.bsky.social", displayName: null },
      ],
    }));
    ctx.web.set("https://writer.example.com/", { body: '<html><head><link rel="alternate" type="application/atom+xml" href="https://writer.example.com/atom.xml"></head></html>' });

    const res = await call(ctx, "POST", "/me/imports/handle", { platform: "bluesky", handle: "@founder" }, cookie);
    expect(res.status).toBe(201);
    const { import: view } = (await res.json()) as { import: ImportView };
    expect(view.label).toBe("@founder.bsky.social on Bluesky");
    expect(view.candidates.map((c) => [c.title, c.group, c.url])).toEqual([
      ["writer.example.com", "Their websites", "https://writer.example.com/atom.xml"],
      ["A Writer", "People you follow", "https://bsky.app/profile/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/rss"],
      ["b.bsky.social", "People you follow", "https://bsky.app/profile/did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/rss"],
    ]);

    const confirm = await call(ctx, "POST", `/me/imports/${view.id}/confirm`, { keys: [view.candidates[1]!.key] }, cookie);
    expect(await confirm.json()).toMatchObject({ added: 1 });
    const [pub] = await ctx.db.select().from(schema.publisher).where(eq(schema.publisher.key, "bsky:did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(pub).toMatchObject({ name: "A Writer", origin: "user_added" });
  });

  it("explains handle problems per platform", async () => {
    const invalid = await call(ctx, "POST", "/me/imports/handle", { platform: "mastodon", handle: "@nobody" }, cookie);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ message: expect.stringMatching(/@name@mastodon.social/) });

    const privateHost = await call(ctx, "POST", "/me/imports/handle", { platform: "mastodon", handle: "@a@10.0.0.1" }, cookie);
    expect(privateHost.status).toBe(400);

    const missing = await call(ctx, "POST", "/me/imports/handle", { platform: "substack", handle: "@ghost" }, cookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });

    ctx.web.set("https://hidden.example/api/v1/accounts/lookup?acct=shy", json({ id: "7", username: "shy", acct: "shy", following_count: 30 }));
    ctx.web.set("https://hidden.example/api/v1/accounts/7/following?limit=80", json({ error: "nope" }, 401));
    const hidden = await call(ctx, "POST", "/me/imports/handle", { platform: "mastodon", handle: "@shy@hidden.example" }, cookie);
    expect(hidden.status).toBe(422);
    expect(await hidden.json()).toMatchObject({ code: "SOURCE_UNAVAILABLE", message: expect.stringMatching(/private/) });
  });

  it("imports Substack subscriptions", async () => {
    ctx.web.set("https://substack.com/api/v1/user/reader/public_profile", json({
      handle: "reader",
      subscriptions: [{ publication: { name: "Big Technology", subdomain: "bigtechnology", custom_domain: "www.bigtechnology.com", custom_domain_optional: false } }],
    }));
    const res = await call(ctx, "POST", "/me/imports/handle", { platform: "substack", handle: "substack.com/@reader" }, cookie);
    expect(res.status).toBe(201);
    const { import: view } = (await res.json()) as { import: ImportView };
    expect(view.candidates).toEqual([expect.objectContaining({ title: "Big Technology", url: "https://www.bigtechnology.com/feed", following: false })]);
  });
});

describe("Connect YouTube", () => {
  it("says when it isn't configured", async () => {
    const res = await call(ctx, "POST", "/me/connections/youtube/start", { returnTo: "foundersignal://sources/import" }, cookie);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    expect((await ctx.app.request(`${BASE_URL}/connections/youtube/callback?state=x&code=y`)).status).toBe(404);
  });

  /** Starts a flow and plays Google's part: returns the callback URL Google would redirect to. */
  async function startFlow(as: string, returnTo = "http://localhost:8081/sources/import") {
    const res = await call(yt, "POST", "/me/connections/youtube/start", { returnTo }, as);
    expect(res.status).toBe(200);
    const consent = new URL(((await res.json()) as { url: string }).url);
    expect(consent.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(consent.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const state = consent.searchParams.get("state")!;
    const code = `code-${state.slice(0, 8)}`;
    google.challenges.set(code, consent.searchParams.get("code_challenge")!);
    return { state, code, callback: `${BASE_URL}/connections/youtube/callback?state=${encodeURIComponent(state)}&code=${code}&scope=x` };
  }

  it("refuses return addresses outside the app", async () => {
    for (const returnTo of ["https://evil.example.com/steal", "http://localhost:9999/x", "javascript:alert(1)"]) {
      expect((await call(yt, "POST", "/me/connections/youtube/start", { returnTo }, ytCookie)).status).toBe(400);
    }
    expect((await yt.app.request(`${BASE_URL}/me/connections/youtube/start`, { method: "POST" })).status).toBe(401);
  });

  it("reads the subscriptions once, forgets the token, and sends the browser back with the import", async () => {
    const { callback } = await startFlow(ytCookie);
    const res = await yt.app.request(callback);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("http://localhost:8081/sources/import");
    const importId = back.searchParams.get("importId")!;
    expect(google.revoked).toEqual(["access-1"]);
    expect(google.subscriptionCalls).toBe(2);

    const { import: view } = (await (await call(yt, "GET", `/me/imports/${importId}`, undefined, ytCookie)).json()) as { import: ImportView };
    expect(view).toMatchObject({ method: "youtube", label: "Your YouTube subscriptions" });
    expect(view.candidates.map((c) => [c.title, c.kind, c.key])).toEqual([
      ["Channel One", "youtube_channel", `youtube:${channel(1)}`],
      ["Channel Two", "youtube_channel", `youtube:${channel(2)}`],
      ["Channel Three", "youtube_channel", `youtube:${channel(3)}`],
    ]);
    // Nothing about the Google account is stored.
    expect(await yt.db.select().from(schema.oauthFlow)).toEqual([]);

    // Another user can't open it.
    expect((await call(yt, "GET", `/me/imports/${importId}`, undefined, ytOtherCookie)).status).toBe(404);

    // Adding a channel uses its uploads playlist.
    const confirm = await call(yt, "POST", `/me/imports/${importId}/confirm`, { keys: [`youtube:${channel(2)}`], mode: "occasional" }, ytCookie);
    expect(await confirm.json()).toMatchObject({ added: 1 });
    const [src] = await yt.db.select().from(schema.source).where(eq(schema.source.canonicalKey, `youtube:${channel(2)}`));
    expect(src).toMatchObject({ type: "youtube_channel", fetchUrl: `UU${channel(2).slice(2)}`, title: "Channel Two" });

    // The state works once.
    const replay = await yt.app.request(callback);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toMatch(/expired or was already used/);
  });

  it("binds the state to the user who started it", async () => {
    const { callback } = await startFlow(ytOtherCookie, "foundersignal://sources/import");
    const res = await yt.app.request(callback);
    const back = new URL(res.headers.get("location")!);
    expect(back.protocol).toBe("foundersignal:");
    const importId = back.searchParams.get("importId")!;
    const [row] = await yt.db.select().from(schema.sourceImport).where(eq(schema.sourceImport.id, importId));
    const [other] = await yt.db.select().from(schema.user).where(eq(schema.user.email, "youtube-other@example.com"));
    expect(row!.userId).toBe(other!.id);
    expect((await call(yt, "GET", `/me/imports/${importId}`, undefined, ytCookie)).status).toBe(404);
  });

  it("handles a denied consent, an unknown state, an expired flow and a bad code", async () => {
    const denied = await startFlow(ytCookie);
    const res = await yt.app.request(`${BASE_URL}/connections/youtube/callback?state=${encodeURIComponent(denied.state)}&error=access_denied`);
    expect(new URL(res.headers.get("location")!).searchParams.get("importError")).toBe("denied");

    expect((await yt.app.request(`${BASE_URL}/connections/youtube/callback?state=made-up&code=x`)).status).toBe(400);
    expect((await yt.app.request(`${BASE_URL}/connections/youtube/callback?code=x`)).status).toBe(400);

    const expired = await startFlow(ytCookie);
    const hash = createHash("sha256").update(expired.state).digest("hex");
    await yt.db.update(schema.oauthFlow).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.oauthFlow.stateHash, hash));
    const late = await yt.app.request(expired.callback);
    expect(new URL(late.headers.get("location")!).searchParams.get("importError")).toBe("expired");

    // A code minted for another flow fails PKCE.
    const a = await startFlow(ytCookie);
    const b = await startFlow(ytCookie);
    const swapped = await yt.app.request(`${BASE_URL}/connections/youtube/callback?state=${encodeURIComponent(a.state)}&code=${b.code}`);
    expect(new URL(swapped.headers.get("location")!).searchParams.get("importError")).toBe("failed");
    const left = await yt.db.select().from(schema.oauthFlow).where(and(eq(schema.oauthFlow.provider, "youtube")));
    expect(left).toHaveLength(1); // b, unused.
  });

  it("reports itself as configured", async () => {
    const list = (await (await call(yt, "GET", "/me/imports", undefined, ytCookie)).json()) as { youtube: { configured: boolean }; imports: { method: string }[] };
    expect(list.youtube.configured).toBe(true);
    expect(list.imports[0]!.method).toBe("youtube");
  });
});
