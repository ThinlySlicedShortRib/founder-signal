import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autodetectFeed,
  buildSections,
  canonicalizeUrl,
  createSafeFetcher,
  detectSource,
  discoverFeedLinks,
  extractArticle,
  type Fetcher,
  hammingDistance,
  isBlockedAddress,
  isUsableTranscript,
  NEAR_DUPLICATE_DISTANCE,
  parseFeed,
  parseIsoDuration,
  parseYouTubeUrl,
  publisherKeyForUrl,
  simhash64,
  SourceDetectionError,
  supadataProvider,
  type YouTubeClient,
} from "../src/index.ts";
import { articleHtml, atomFeed, paywalledHtml, prose, rdfFeed, rssFeed } from "./fixtures.ts";

describe("canonicalizeUrl", () => {
  it("strips tracking, fragments and trailing slashes, lowercases the host and sorts the query", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM:443/Posts/A/?utm_source=x&b=2&a=1&fbclid=z#top")).toBe(
      "https://example.com/Posts/A?a=1&b=2",
    );
  });

  it("keeps the root slash and meaningful parameters", () => {
    expect(canonicalizeUrl("https://example.com/?s=pricing")).toBe("https://example.com/?s=pricing");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("rejects other schemes", () => {
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow();
  });

  it("keys publishers by host without www", () => {
    expect(publisherKeyForUrl("https://WWW.Example.com/x")).toBe("example.com");
  });
});

describe("parseYouTubeUrl", () => {
  it.each([
    ["https://youtu.be/abc123", { kind: "video", videoId: "abc123" }],
    ["https://www.youtube.com/watch?v=abc123&t=10", { kind: "video", videoId: "abc123" }],
    ["https://youtube.com/shorts/xyz", { kind: "video", videoId: "xyz" }],
    ["https://www.youtube.com/@founderstalk", { kind: "handle", handle: "@founderstalk" }],
    ["https://www.youtube.com/channel/UC123", { kind: "channel", channelId: "UC123" }],
    ["https://www.youtube.com/c/oldname", { kind: "legacy", name: "oldname" }],
  ])("%s", (url, expected) => {
    expect(parseYouTubeUrl(url)).toEqual(expected);
  });

  it("ignores other sites", () => {
    expect(parseYouTubeUrl("https://example.com/watch?v=1")).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"])(
    "blocks %s",
    (addr) => expect(isBlockedAddress(addr)).toBe(true),
  );

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });
});

describe("parseFeed", () => {
  it("reads RSS 2.0, resolving relative links and skipping linkless items", () => {
    const feed = parseFeed(rssFeed, "https://example.com/feed.xml")!;
    expect(feed.title).toBe("Example Blog");
    expect(feed.siteUrl).toBe("https://example.com/");
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]).toMatchObject({
      url: "https://example.com/posts/productized-service?utm_source=rss",
      title: "Moving from consulting & services",
      author: "Ada Founder",
      guid: "post-1",
    });
    expect(feed.entries[0]!.publishedAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
    expect(feed.entries[1]).toMatchObject({ url: "https://example.com/posts/relative", publishedAt: null });
  });

  it("reads Atom", () => {
    const feed = parseFeed(atomFeed, "https://atom.example.org/feed.atom")!;
    expect(feed.siteUrl).toBe("https://atom.example.org/");
    expect(feed.entries[0]).toMatchObject({
      url: "https://atom.example.org/2026/hiring",
      title: "Hiring your first salesperson",
      author: "Bo Builder",
    });
  });

  it("reads RSS 1.0 (RDF)", () => {
    const feed = parseFeed(rdfFeed, "https://rdf.example.net/index.rdf")!;
    expect(feed.title).toBe("RDF Site");
    expect(feed.entries.map((e) => e.url)).toEqual(["https://rdf.example.net/one"]);
  });

  it("returns null for HTML", () => {
    expect(parseFeed("<html><body>hi</body></html>", "https://example.com/")).toBeNull();
  });
});

describe("discoverFeedLinks", () => {
  it("finds advertised feeds and skips comment feeds", () => {
    expect(discoverFeedLinks(articleHtml(), "https://example.com/posts/x")).toEqual(["https://example.com/feed.xml"]);
  });
});

describe("extractArticle", () => {
  const article = extractArticle(articleHtml(), "https://example.com/posts/productized-service?utm_source=x");

  it("reads metadata", () => {
    expect(article.metadata).toMatchObject({
      title: "Moving from consulting to a productized service",
      siteName: "Example Blog",
      byline: "Ada Founder",
      language: "en",
      canonicalUrl: "https://example.com/posts/productized-service",
    });
    expect(article.metadata.publishedAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("produces typed blocks without the page chrome, scripts or the duplicated title", () => {
    expect(article.unavailableReason).toBeNull();
    const types = new Set(article.blocks.map((b) => b.type));
    expect(types).toEqual(new Set(["paragraph", "heading", "image", "list", "quote", "table"]));
    expect(article.blocks[0]?.type).toBe("paragraph");
    expect(article.text).not.toContain("tracking");
    expect(article.text).not.toContain("About");
    expect(article.blocks).toContainEqual({
      type: "image",
      src: "https://example.com/img/chart.png",
      alt: "Revenue chart",
      caption: "Revenue after the switch",
    });
    expect(article.blocks).toContainEqual({ type: "table", header: ["Plan", "Price"], rows: [["Starter", "$2,000"]] });
    expect(article.wordCount).toBeGreaterThan(400);
    expect(article.excerpt).toMatch(/…$/);
  });

  it("maps sections at headings", () => {
    expect(article.sections.map((s) => s.title)).toEqual([null, "Pricing the first package"]);
    expect(article.sections[1]!.endBlock).toBe(article.blocks.length);
  });

  it("keeps headings whose class looks like page chrome", () => {
    const html = articleHtml().replace("<h2>Pricing the first package</h2>", '<h2 class="header-anchor-post">Pricing the first package</h2>');
    const extracted = extractArticle(html, "https://example.substack.com/p/x");
    expect(extracted.sections.map((s) => s.title)).toContain("Pricing the first package");
  });

  it("is deterministic", () => {
    const again = extractArticle(articleHtml(), "https://example.com/posts/productized-service");
    expect(again.contentHash).toBe(article.contentHash);
  });

  it("marks a paywalled teaser metadata-only and keeps no text", () => {
    const paywalled = extractArticle(paywalledHtml, "https://news.example.com/premium");
    expect(paywalled.unavailableReason).toBe("paywalled");
    expect(paywalled.blocks).toEqual([]);
    expect(paywalled.text).toBe("");
    expect(paywalled.metadata.title).toBe("The subscriber-only playbook");
  });

  it("marks empty pages too short but keeps genuinely short posts", () => {
    const stub = extractArticle("<html><head><title>Hi</title></head><body><p>Just a stub.</p></body></html>", "https://e.com/x");
    expect(stub.unavailableReason).toBe("too_short");
    const short = extractArticle(articleHtml({ paragraphs: 2 }), "https://e.com/y");
    expect(short.unavailableReason).toBeNull();
  });
});

describe("buildSections", () => {
  it("chunks long runs without headings", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => ({ type: "paragraph" as const, text: prose(6, i) }));
    const sections = buildSections(blocks);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections[0]!.startBlock).toBe(0);
    for (let i = 1; i < sections.length; i++) expect(sections[i]!.startBlock).toBe(sections[i - 1]!.endBlock);
    expect(sections.at(-1)!.endBlock).toBe(20);
  });
});

describe("simhash64", () => {
  const base = prose(60);
  it("is close for a lightly edited repost and far for different text", () => {
    const repost = `${base} Originally published on another site.`;
    expect(hammingDistance(simhash64(base)!, simhash64(repost)!)).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
    const other = "An entirely different essay about raising a seed round from angels in a cold market.".repeat(20);
    expect(hammingDistance(simhash64(base)!, simhash64(other)!)).toBeGreaterThan(NEAR_DUPLICATE_DISTANCE);
  });

  it("fits a signed bigint", () => {
    const h = simhash64(base)!;
    expect(h).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(h).toBeLessThan(2n ** 63n);
  });
});

describe("createSafeFetcher", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") return res.writeHead(302, { location: "/article" }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/to-file") return res.writeHead(302, { location: "file:///etc/passwd" }).end();
      if (req.url === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(2_000));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(articleHtml());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses private addresses by default", async () => {
    await expect(createSafeFetcher()(`${origin}/article`)).rejects.toMatchObject({ reason: "blocked_address" });
    await expect(createSafeFetcher()("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("refuses hostnames that resolve to private addresses", async () => {
    await expect(createSafeFetcher()(`http://localhost:${new URL(origin).port}/article`)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  describe("against a fixture server", () => {
    const fetcher = () => createSafeFetcher({ allowPrivateNetworks: true, maxBytes: 1_000_000, maxRedirects: 3 });

    it("follows redirects and reports the final URL", async () => {
      const res = await fetcher()(`${origin}/redirect`);
      expect(res).toMatchObject({ status: 200, url: `${origin}/article` });
      expect(res.body).toContain("productized");
    });

    it("stops redirect loops", async () => {
      await expect(fetcher()(`${origin}/loop`)).rejects.toMatchObject({ reason: "too_many_redirects" });
    });

    it("won't follow a redirect to another scheme", async () => {
      await expect(fetcher()(`${origin}/to-file`)).rejects.toMatchObject({ reason: "bad_url" });
    });

    it("caps the response size", async () => {
      const small = createSafeFetcher({ allowPrivateNetworks: true, maxBytes: 1_000 });
      await expect(small(`${origin}/big`)).rejects.toMatchObject({ reason: "too_large" });
    });
  });
});

describe("detectSource", () => {
  const pages: Record<string, { status?: number; contentType: string; body: string }> = {
    "https://example.com/": { contentType: "text/html", body: articleHtml().replace('og:type" content="article"', 'og:type" content="website"') },
    "https://example.com/feed.xml": { contentType: "application/rss+xml", body: rssFeed },
    "https://example.com/posts/productized-service": { contentType: "text/html", body: articleHtml() },
    "https://nofeed.example.com/": { contentType: "text/html", body: "<html><head><title>No feed</title></head><body></body></html>" },
    "https://example.com/gone": { status: 404, contentType: "text/html", body: "" },
    "https://news.example.com/premium": { status: 403, contentType: "text/html", body: "Subscribe" },
  };
  const fetch: Fetcher = async (url) => {
    const page = pages[url];
    if (!page) return { status: 404, url, contentType: "text/html", headers: new Headers(), body: "" };
    return { status: page.status ?? 200, url, contentType: page.contentType, headers: new Headers(), body: page.body };
  };
  const youtube: YouTubeClient = {
    async resolveChannel(ref) {
      return ref.kind === "handle" ? { channelId: "UC1", title: "Founders Talk", uploadsPlaylistId: "UU1" } : null;
    },
    async listUploads() {
      return [];
    },
    async getVideo(id) {
      return { videoId: id, channelId: "UC1", channelTitle: "Founders Talk", title: "Episode 1", description: "", publishedAt: null };
    },
  };

  it("follows a homepage's advertised feed", async () => {
    const source = await detectSource("example.com", { fetch, youtube });
    expect(source).toMatchObject({
      type: "feed",
      canonicalKey: "https://example.com/feed.xml",
      fetchUrl: "https://example.com/feed.xml",
      title: "Example Blog",
      publisher: { key: "example.com", name: "Example Blog", feedUrl: "https://example.com/feed.xml" },
    });
  });

  it("accepts a feed URL directly", async () => {
    const source = await detectSource("https://example.com/feed.xml", { fetch, youtube });
    expect(source).toMatchObject({ type: "feed", publisher: { key: "example.com" } });
  });

  it("treats an article as a one-off URL but records its publisher's feed", async () => {
    const source = await detectSource("https://example.com/posts/productized-service", { fetch, youtube });
    expect(source).toMatchObject({
      type: "url",
      canonicalKey: "https://example.com/posts/productized-service",
      publisher: { key: "example.com", feedUrl: "https://example.com/feed.xml" },
    });
  });

  it("falls back to a single page when a site has no feed", async () => {
    expect((await detectSource("https://nofeed.example.com/", { fetch, youtube })).type).toBe("url");
  });

  it("resolves YouTube channels and videos", async () => {
    expect(await detectSource("https://www.youtube.com/@founderstalk", { fetch, youtube })).toMatchObject({
      type: "youtube_channel",
      canonicalKey: "youtube:UC1",
      fetchUrl: "UU1",
      publisher: { key: "youtube:UC1", name: "Founders Talk" },
    });
    expect(await detectSource("https://youtu.be/vid1", { fetch, youtube })).toMatchObject({
      type: "url",
      canonicalKey: "https://www.youtube.com/watch?v=vid1",
    });
  });

  it("keeps a paywalled or bot-walled link as a single page", async () => {
    expect(await detectSource("https://news.example.com/premium", { fetch, youtube })).toMatchObject({
      type: "url",
      canonicalKey: "https://news.example.com/premium",
      publisher: { key: "news.example.com" },
    });
  });

  it("explains failures", async () => {
    await expect(detectSource("not a url", { fetch, youtube })).rejects.toBeInstanceOf(SourceDetectionError);
    await expect(detectSource("https://example.com/gone", { fetch, youtube })).rejects.toMatchObject({ reason: "unreachable" });
    await expect(detectSource("https://youtube.com/@x", { fetch, youtube: null })).rejects.toMatchObject({
      reason: "youtube_unavailable",
    });
  });
});

describe("supadataProvider", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(body === null ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns native captions", async () => {
    const provider = supadataProvider({
      apiKey: "k",
      fetch: respond(200, { content: [{ text: " Hello ", offset: 0, duration: 1000, lang: "en" }], lang: "en", availableLangs: ["en"] }),
    });
    const t = await provider.get("vid1");
    expect(t).toEqual({
      segments: [{ text: "Hello", offsetMs: 0, durationMs: 1000 }],
      provider: "supadata",
      kind: "native",
      language: "en",
      confidence: null,
    });
    expect(isUsableTranscript(t)).toBe(true);
  });

  it("returns null when the video has no transcript", async () => {
    const provider = supadataProvider({ apiKey: "k", fetch: respond(206, { error: "transcript-unavailable" }) });
    expect(await provider.get("vid1")).toBeNull();
  });

  it("throws on provider errors so the queue retries", async () => {
    const provider = supadataProvider({ apiKey: "k", fetch: respond(500, { error: "boom" }) });
    await expect(provider.get("vid1")).rejects.toThrow(/Supadata 500/);
  });

  it("asks for native captions only unless generation is allowed", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ error: "x" }), { status: 206 });
    }) as unknown as typeof globalThis.fetch;
    const provider = supadataProvider({ apiKey: "k", fetch });
    await provider.get("v");
    await provider.get("v", { allowGenerated: true });
    expect(urls.map((u) => new URL(u).searchParams.get("mode"))).toEqual(["native", "auto"]);
  });
});

describe("lead images and video details", () => {
  it("reads og:image, resolved against the page", () => {
    const html = `<html><head><title>T</title><meta property="og:image" content="/img/lead.jpg"></head><body><article>${prose(6)}</article></body></html>`;
    expect(extractArticle(html, "https://site.test/post").metadata.leadImageUrl).toBe("https://site.test/img/lead.jpg");
  });

  it("falls back to twitter:image, then the article's first image", () => {
    const tw = `<html><head><meta name="twitter:image" content="https://cdn.test/t.png"></head><body><article>${prose(6)}</article></body></html>`;
    expect(extractArticle(tw, "https://site.test/a").metadata.leadImageUrl).toBe("https://cdn.test/t.png");
    const inline = `<html><body><article><p>${"word ".repeat(80)}</p><figure><img src="/pic.jpg" alt="x"></figure>${prose(6)}</article></body></html>`;
    expect(extractArticle(inline, "https://site.test/b").metadata.leadImageUrl).toBe("https://site.test/pic.jpg");
  });

  it("ignores non-http images", () => {
    const html = `<html><head><meta property="og:image" content="data:image/png;base64,AAAA"></head><body><article>${prose(6)}</article></body></html>`;
    expect(extractArticle(html, "https://site.test/c").metadata.leadImageUrl).toBeNull();
  });

  it("parses YouTube durations", () => {
    expect(parseIsoDuration("PT18M3S")).toBe(1083);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("P1DT2M")).toBe(86_520);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

describe("autodetectFeed", () => {
  const plain = "<html><head><title>Post</title></head><body><p>Hi</p></body></html>";
  const fetcher = (pages: Record<string, { contentType: string; body: string }>) => {
    const requested: string[] = [];
    const fetch: Fetcher = async (url) => {
      requested.push(url);
      const page = pages[url];
      if (!page) return { status: 404, url, contentType: "text/html", headers: new Headers(), body: "" };
      return { status: 200, url, contentType: page.contentType, headers: new Headers(), body: page.body };
    };
    return { fetch, requested };
  };

  it("uses the feed the page advertises", async () => {
    const { fetch, requested } = fetcher({ "https://example.com/feed.xml": { contentType: "application/rss+xml", body: rssFeed } });
    const found = await autodetectFeed({ body: articleHtml(), url: "https://example.com/posts/a" }, fetch);
    expect(found).toEqual({ feedUrl: "https://example.com/feed.xml", title: "Example Blog" });
    expect(requested).toEqual(["https://example.com/feed.xml"]);
  });

  it("falls back to the homepage's feed, then common paths, within the probe cap", async () => {
    const viaHome = fetcher({
      "https://example.com/": { contentType: "text/html", body: articleHtml() },
      "https://example.com/feed.xml": { contentType: "application/rss+xml", body: rssFeed },
    });
    expect((await autodetectFeed({ body: plain, url: "https://example.com/posts/a" }, viaHome.fetch))?.feedUrl).toBe("https://example.com/feed.xml");

    const viaPath = fetcher({ "https://example.com/rss": { contentType: "application/rss+xml", body: rssFeed } });
    expect((await autodetectFeed({ body: plain, url: "https://example.com/posts/a" }, viaPath.fetch))?.feedUrl).toBe("https://example.com/rss");

    const none = fetcher({});
    expect(await autodetectFeed({ body: plain, url: "https://example.com/posts/a" }, none.fetch)).toBeNull();
    expect(none.requested.length).toBeLessThanOrEqual(6);
  });

  it("never probes another site", async () => {
    const html = '<html><head><link rel="alternate" type="application/rss+xml" href="https://elsewhere.test/feed.xml"></head></html>';
    const { fetch, requested } = fetcher({});
    await autodetectFeed({ body: html, url: "https://example.com/posts/a" }, fetch);
    expect(requested.every((u) => u.startsWith("https://example.com/"))).toBe(true);
  });
});
