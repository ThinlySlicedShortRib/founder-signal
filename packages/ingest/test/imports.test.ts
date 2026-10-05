import { describe, expect, it } from "vitest";
import {
  dedupeFound,
  exchangeGoogleCode,
  FetchError,
  type Fetcher,
  type FetchResult,
  findSiteFeeds,
  foundFeed,
  foundSourceKey,
  googleAuthUrl,
  ImportFailure,
  importBluesky,
  importMastodon,
  importSubstack,
  isWebsiteLink,
  listYouTubeSubscriptions,
  OpmlError,
  parseBlueskyHandle,
  parseMastodonHandle,
  parseOpml,
  parseSubstackHandle,
  PEOPLE_GROUP,
  settleSites,
  WEBSITES_GROUP,
  YOUTUBE_READONLY_SCOPE,
} from "../src/index.ts";

/** A fake web: URL → response. Anything else is a 404. Records what was asked for. */
function fakeWeb(pages: Record<string, { status?: number; body: unknown; contentType?: string; headers?: Record<string, string>; delayMs?: number }>) {
  const requested: string[] = [];
  const fetch: Fetcher = async (url) => {
    requested.push(url);
    const page = pages[url];
    if (page?.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
    const body = page ? (typeof page.body === "string" ? page.body : JSON.stringify(page.body)) : "";
    return {
      status: page ? (page.status ?? 200) : 404,
      url,
      contentType: page?.contentType ?? (typeof page?.body === "string" ? "text/html" : "application/json"),
      headers: new Headers(page?.headers),
      body,
    } satisfies FetchResult;
  };
  return { fetch, requested };
}

describe("parseOpml", () => {
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Feedly subscriptions</title></head>
  <body>
    <outline text="Startups" title="Startups">
      <outline type="rss" text="Paul Graham" title="Paul Graham: Essays" xmlUrl="http://www.aaronsw.com/2002/feeds/pgessays.rss" htmlUrl="http://paulgraham.com/"/>
      <outline text="Deep">
        <outline type="rss" text="Both &amp; more" XMLURL="https://both.example.com/feed?a=1&amp;b=2"/>
      </outline>
    </outline>
    <outline type="rss" text="Stratechery" xmlUrl="https://stratechery.com/feed/" htmlUrl="https://stratechery.com"/>
    <outline text="Only a site" htmlUrl="https://www.site.example.org/blog"/>
    <outline text="Nothing here"/>
    <outline text="Bad scheme" xmlUrl="javascript:alert(1)"/>
    <outline text="Podcast" xmlUrl="feed://pod.example.net/rss"/>
    <outline text="A channel" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx"/>
  </body>
</opml>`;

  it("reads nested folders, sites without a feed, YouTube channel feeds and odd attribute cases", () => {
    const result = parseOpml(opml);
    expect(result.title).toBe("Feedly subscriptions");
    expect(result.skipped).toBe(2);
    expect(result.found.map((f) => [f.title, f.kind, f.check, f.group, f.url])).toEqual([
      ["Paul Graham: Essays", "feed", "ready", "Startups", "http://www.aaronsw.com/2002/feeds/pgessays.rss"],
      ["Both & more", "feed", "ready", "Deep", "https://both.example.com/feed?a=1&b=2"],
      ["Stratechery", "feed", "ready", null, "https://stratechery.com/feed/"],
      ["Only a site", "feed", "site", null, "https://www.site.example.org/blog"],
      ["Podcast", "feed", "ready", null, "https://pod.example.net/rss"],
      ["A channel", "youtube_channel", "ready", null, "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"],
    ]);
    // The publisher is the site (htmlUrl) when known, not the feed host.
    expect(result.found[0]!.publisher.key).toBe("paulgraham.com");
  });

  it("refuses what isn't OPML, DOCTYPEs (entity bombs) and oversized files", () => {
    expect(() => parseOpml("<html><body>hi</body></html>")).toThrow(OpmlError);
    expect(() => parseOpml("not xml at all <<<")).toThrow(OpmlError);
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><opml><body><outline text="&lol2;" xmlUrl="https://a.example.com/f"/></body></opml>`;
    expect(() => parseOpml(bomb)).toThrow(/DOCTYPE/);
    const external = `<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><opml><body/></opml>`;
    expect(() => parseOpml(external)).toThrow(OpmlError);
    expect(() => parseOpml(`<opml><body>${"<outline/>".repeat(10)}</body></opml>`, { maxBytes: 50 })).toThrow(/over/);
  });

  it("copes with a big export: thousands of entries, deep nesting", () => {
    const entries = Array.from({ length: 5_000 }, (_, i) => `<outline type="rss" text="F${i}" xmlUrl="https://f${i}.example.com/feed"/>`).join("");
    const deep = `${"<outline text='d'>".repeat(60)}<outline text="deep" xmlUrl="https://deep.example.com/feed"/>${"</outline>".repeat(60)}`;
    const result = parseOpml(`<opml><body>${entries}${deep}</body></opml>`);
    expect(result.found).toHaveLength(5_000);
    const { kept, overCap } = dedupeFound(result.found, 300);
    expect(kept).toHaveLength(300);
    expect(overCap).toBe(4_700);
  });

  it("dedupes by canonical key", () => {
    const { kept } = dedupeFound(
      [foundFeed("https://a.example.com/feed?utm_source=x", { title: "A" }), foundFeed("https://A.example.com/feed/", { title: "A again" })],
      10,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.key).toBe("https://a.example.com/feed");
    expect(foundSourceKey({ kind: "feed", check: "site", url: "https://b.example.com/" })).toBe("site:https://b.example.com/");
  });
});

describe("handles", () => {
  it("normalises Substack handles", () => {
    expect(parseSubstackHandle("@Lenny")).toBe("lenny");
    expect(parseSubstackHandle("lenny")).toBe("lenny");
    expect(parseSubstackHandle("https://substack.com/@lenny?utm_source=x")).toBe("lenny");
    expect(parseSubstackHandle("lenny.substack.com")).toBe("lenny");
    expect(parseSubstackHandle("https://lenny.substack.com/p/post")).toBe("lenny");
    expect(parseSubstackHandle("https://example.com/@x")).toBeNull();
    expect(parseSubstackHandle("two words")).toBeNull();
    expect(parseSubstackHandle("../../etc")).toBeNull();
  });

  it("normalises Bluesky handles", () => {
    expect(parseBlueskyHandle("@Jay.bsky.team")).toBe("jay.bsky.team");
    expect(parseBlueskyHandle("alice")).toBe("alice.bsky.social");
    expect(parseBlueskyHandle("https://bsky.app/profile/pfrazee.com")).toBe("pfrazee.com");
    expect(parseBlueskyHandle("did:plc:oky5czdrnfjpqslsw2a5iclo")).toBe("did:plc:oky5czdrnfjpqslsw2a5iclo");
    expect(parseBlueskyHandle("https://example.com/profile/x")).toBeNull();
    expect(parseBlueskyHandle("not a handle!")).toBeNull();
  });

  it("normalises Mastodon handles and refuses private hosts", () => {
    expect(parseMastodonHandle("@Gargron@mastodon.social")).toEqual({ user: "Gargron", host: "mastodon.social" });
    expect(parseMastodonHandle("gargron@Mastodon.Social")).toEqual({ user: "gargron", host: "mastodon.social" });
    expect(parseMastodonHandle("https://hachyderm.io/@nova")).toEqual({ user: "nova", host: "hachyderm.io" });
    expect(parseMastodonHandle("https://mastodon.social/@someone@hachyderm.io")).toEqual({ user: "someone", host: "hachyderm.io" });
    expect(parseMastodonHandle("@gargron")).toBeNull();
    expect(parseMastodonHandle("@a@127.0.0.1")).toBeNull();
    expect(parseMastodonHandle("@a@localhost")).toBeNull();
    expect(parseMastodonHandle("@a@printer.local")).toBeNull();
    expect(parseMastodonHandle("https://mastodon.social:8443/@a")).toBeNull();
  });

  it("tells websites from profiles", () => {
    expect(isWebsiteLink("https://pfrazee.com/")).toBe(true);
    expect(isWebsiteLink("https://x.com/someone")).toBe(false);
    expect(isWebsiteLink("https://www.linkedin.com/in/x")).toBe(false);
    expect(isWebsiteLink("ftp://files.example.com/")).toBe(false);
  });
});

describe("importSubstack", () => {
  const pub = (name: string, subdomain: string, custom: string | null, optional = false) => ({
    publication: { name, subdomain, custom_domain: custom, custom_domain_optional: optional, author: { name: `${name} author` } },
  });

  it("lists each public subscription's feed, on its custom domain when that's the real one", async () => {
    const { fetch, requested } = fakeWeb({
      "https://substack.com/api/v1/user/lenny/public_profile": {
        body: {
          handle: "lenny",
          subscriptions: [pub("Big Technology", "bigtechnology", "www.bigtechnology.com"), pub("Plain", "plain", null), pub("Optional", "opt", "opt.example.com", true)],
          subscriptionsTruncated: false,
        },
      },
    });
    const result = await importSubstack("lenny", fetch);
    expect(requested).toEqual(["https://substack.com/api/v1/user/lenny/public_profile"]);
    expect(result.label).toBe("@lenny on Substack");
    expect(result.found.map((f) => [f.title, f.url, f.publisher.key])).toEqual([
      ["Big Technology", "https://www.bigtechnology.com/feed", "bigtechnology.com"],
      ["Plain", "https://plain.substack.com/feed", "plain.substack.com"],
      ["Optional", "https://opt.substack.com/feed", "opt.substack.com"],
    ]);
    expect(result.found[0]!.detail).toBe("Big Technology author · bigtechnology.com");
  });

  it("explains unknown handles, hidden subscriptions and a changed API", async () => {
    await expect(importSubstack("nobody", fakeWeb({}).fetch)).rejects.toMatchObject({ reason: "not_found" });
    const empty = await importSubstack("quiet", fakeWeb({ "https://substack.com/api/v1/user/quiet/public_profile": { body: { handle: "quiet", subscriptions: [] } } }).fetch);
    expect(empty.found).toEqual([]);
    expect(empty.notes[0]).toMatch(/doesn't show any subscriptions/);
    const changed = fakeWeb({ "https://substack.com/api/v1/user/x/public_profile": { body: "<html>login</html>", contentType: "text/html" } });
    await expect(importSubstack("x", changed.fetch)).rejects.toThrow(/no official API/);
  });
});

describe("importBluesky", () => {
  const follow = (n: number, handle = `p${n}.bsky.social`, description: string | null = null) => ({
    did: `did:plc:${"a".repeat(23)}${n}`,
    handle,
    displayName: `Person ${n}`,
    description,
  });
  const api = "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows";

  it("follows the cursor, makes each follow an RSS feed and offers their websites", async () => {
    const { fetch, requested } = fakeWeb({
      [`${api}?actor=jay.bsky.team&limit=100`]: {
        body: { subject: { handle: "jay.bsky.team" }, follows: [follow(1), follow(2, "pfrazee.com")], cursor: "c2" },
      },
      [`${api}?actor=jay.bsky.team&limit=100&cursor=c2`]: {
        body: { subject: { handle: "jay.bsky.team" }, follows: [follow(3, "p3.bsky.social", "I write at https://blog.example.com. Also https://x.com/p3")] },
      },
    });
    const result = await importBluesky("jay.bsky.team", fetch);
    expect(requested).toHaveLength(2);
    expect(result.label).toBe("@jay.bsky.team on Bluesky");
    const people = result.found.filter((f) => f.group === PEOPLE_GROUP);
    expect(people.map((f) => f.url)).toEqual([1, 2, 3].map((n) => `https://bsky.app/profile/did:plc:${"a".repeat(23)}${n}/rss`));
    expect(people[0]).toMatchObject({ title: "Person 1", detail: "@p1.bsky.social · Bluesky posts", publisher: { key: `bsky:did:plc:${"a".repeat(23)}1` } });
    const sites = result.found.filter((f) => f.group === WEBSITES_GROUP);
    expect(sites.map((f) => [f.url, f.check])).toEqual([
      ["https://pfrazee.com/", "site"],
      ["https://blog.example.com/", "site"],
    ]);
  });

  it("explains an unknown account and an outage", async () => {
    const notFound = fakeWeb({ [`${api}?actor=nobody.bsky.social&limit=100`]: { status: 400, body: { error: "InvalidRequest", message: "Actor not found: nobody.bsky.social" } } });
    await expect(importBluesky("nobody.bsky.social", notFound.fetch)).rejects.toMatchObject({ reason: "not_found" });
    const down = fakeWeb({ [`${api}?actor=a.bsky.social&limit=100`]: { status: 502, body: "bad gateway", contentType: "text/html" } });
    await expect(importBluesky("a.bsky.social", down.fetch)).rejects.toMatchObject({ reason: "unavailable" });
  });
});

describe("importMastodon", () => {
  const acct = (id: string, acctName: string, url: string, fields: { name: string; value: string; verified_at?: string | null }[] = []) => ({
    id,
    username: acctName.split("@")[0],
    acct: acctName,
    url,
    display_name: `Name ${id}`,
    fields,
  });
  const lookup = "https://mastodon.example/api/v1/accounts/lookup?acct=me";
  const first = "https://mastodon.example/api/v1/accounts/42/following?limit=80";

  it("pages with the Link header on the same server only, and offers verified websites", async () => {
    const { fetch, requested } = fakeWeb({
      [lookup]: { body: acct("42", "me", "https://mastodon.example/@me") },
      [first]: {
        body: [
          acct("1", "local", "https://mastodon.example/@local", [
            { name: "Site", value: '<a href="https://unverified.example.com" rel="me">x</a>', verified_at: null },
            { name: "Blog", value: '<a href="https://verified.example.com/" rel="me">y</a>', verified_at: "2026-01-01" },
          ]),
          acct("2", "far@other.example", "https://other.example/@far"),
        ],
        headers: { link: '<https://mastodon.example/api/v1/accounts/42/following?limit=80&max_id=2>; rel="next", <https://mastodon.example/api/v1/accounts/42/following?since_id=9>; rel="prev"' },
      },
      "https://mastodon.example/api/v1/accounts/42/following?limit=80&max_id=2": {
        body: [acct("3", "threads@threads.net", "https://www.threads.net/@threads"), acct("4", "pl@pleroma.example", "https://pleroma.example/users/pl")],
        // A next link to another server is ignored.
        headers: { link: '<https://evil.example/api/v1/accounts/42/following?max_id=4>; rel="next"' },
      },
    });
    const result = await importMastodon({ user: "me", host: "mastodon.example" }, fetch);
    expect(requested).not.toContain("https://evil.example/api/v1/accounts/42/following?max_id=4");
    expect(requested).toHaveLength(3);
    expect(result.label).toBe("@me@mastodon.example");
    expect(result.found.filter((f) => f.group === PEOPLE_GROUP).map((f) => [f.url, f.detail, f.publisher.key])).toEqual([
      ["https://mastodon.example/@local.rss", "@local@mastodon.example", "mastodon:local@mastodon.example"],
      ["https://other.example/@far.rss", "@far@other.example", "mastodon:far@other.example"],
    ]);
    expect(result.found.filter((f) => f.group === WEBSITES_GROUP).map((f) => f.url)).toEqual(["https://verified.example.com/"]);
    expect(result.notes.join(" ")).toMatch(/2 accounts are on servers without a public RSS feed/);
  });

  it("says when follows are hidden (401, or empty despite a following count)", async () => {
    const hidden401 = fakeWeb({ [lookup]: { body: acct("42", "me", "https://mastodon.example/@me") }, [first]: { status: 401, body: { error: "This method requires an authenticated user" } } });
    await expect(importMastodon({ user: "me", host: "mastodon.example" }, hidden401.fetch)).rejects.toMatchObject({ reason: "hidden" });
    const hiddenEmpty = fakeWeb({ [lookup]: { body: { ...acct("42", "me", "https://mastodon.example/@me"), following_count: 120 } }, [first]: { body: [] } });
    await expect(importMastodon({ user: "me", host: "mastodon.example" }, hiddenEmpty.fetch)).rejects.toThrow(/keeps who they follow private/);
    const unknown = fakeWeb({ [lookup]: { status: 404, body: { error: "Record not found" } } });
    await expect(importMastodon({ user: "me", host: "mastodon.example" }, unknown.fetch)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("never fetches a blocked address (the SSRF-safe fetcher refuses it)", async () => {
    const blocked: Fetcher = async () => {
      throw new FetchError("blocked_address", "mastodon.example resolves to a blocked address (10.0.0.5)");
    };
    const err = await importMastodon({ user: "me", host: "mastodon.example" }, blocked).catch((e) => e);
    expect(err).toBeInstanceOf(ImportFailure);
    expect(err.message).toBe("That address isn't allowed");
  });
});

describe("websites", () => {
  it("turns sites with an advertised feed into feeds; the rest stay sites, or are dropped when strict", async () => {
    const { fetch } = fakeWeb({
      "https://has.example.com/": { body: '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>' },
      "https://none.example.com/": { body: "<html><head></head></html>" },
      "https://slow.example.com/": { body: "<html></html>", delayMs: 300 },
      "https://feed.example.com/atom": { body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', contentType: "application/atom+xml" },
    });
    const site = (url: string) => ({ kind: "feed" as const, check: "site" as const, title: url, detail: null, group: null, url, publisher: { key: "k", name: "n" } });
    const sites = [site("https://has.example.com/"), site("https://none.example.com/"), site("https://slow.example.com/"), site("https://feed.example.com/atom")];

    const lenient = await settleSites(sites, fetch, { deadlineMs: 100 });
    expect(lenient.found.map((f) => [f.url, f.check])).toEqual([
      ["https://has.example.com/rss.xml", "ready"],
      ["https://none.example.com/", "site"],
      ["https://slow.example.com/", "site"],
      ["https://feed.example.com/atom", "ready"],
    ]);
    expect(lenient.found[0]!.publisher.key).toBe("has.example.com");

    const strict = await settleSites(sites, fetch, { deadlineMs: 100, strict: true });
    expect(strict).toMatchObject({ noFeed: 1, unchecked: 1 });
    expect(strict.found.map((f) => f.url)).toEqual(["https://has.example.com/rss.xml", "https://feed.example.com/atom"]);
  });

  it("checks at most `max` sites", async () => {
    const { fetch, requested } = fakeWeb({});
    await findSiteFeeds(Array.from({ length: 20 }, (_, i) => `https://s${i}.example.com/`), fetch, { max: 5 });
    expect(requested).toHaveLength(5);
  });
});

describe("YouTube subscriptions (Google OAuth)", () => {
  const config = { clientId: "cid", clientSecret: "secret", redirectUrl: "http://localhost:8787/connections/youtube/callback" };

  it("asks only for youtube.readonly, online access, with PKCE", () => {
    const url = new URL(googleAuthUrl(config, { state: "st", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: config.redirectUrl,
      scope: YOUTUBE_READONLY_SCOPE,
      access_type: "online",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      response_type: "code",
    });
  });

  it("refuses a token without the YouTube scope", async () => {
    const fetch = (async () => Response.json({ access_token: "t", scope: "openid" })) as unknown as typeof globalThis.fetch;
    await expect(exchangeGoogleCode(config, { code: "c", codeVerifier: "v" }, { fetch })).rejects.toMatchObject({ reason: "scope_missing" });
  });

  it("pages through subscriptions and stops at maxPages", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
      const page = new URL(url).searchParams.get("pageToken");
      const id = (n: number) => `UC${String(n).padStart(22, "0")}`;
      return Response.json({
        nextPageToken: page === "p3" ? undefined : page ? `p${Number(page.slice(1)) + 1}` : "p1",
        items: [{ snippet: { title: `Channel ${page ?? "p0"}`, resourceId: { kind: "youtube#channel", channelId: id(calls.length) } } }],
      });
    }) as unknown as typeof globalThis.fetch;
    const all = await listYouTubeSubscriptions("tok", { fetch });
    expect(all.subscriptions).toHaveLength(4);
    expect(all.truncated).toBe(false);
    expect(new URL(calls[0]!).searchParams.get("mine")).toBe("true");
    calls.length = 0;
    const capped = await listYouTubeSubscriptions("tok", { fetch, maxPages: 2 });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.subscriptions).toHaveLength(2);
  });
});
