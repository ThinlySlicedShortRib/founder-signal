import type { SourceType } from "@fs/schema";
import { parseHTML } from "linkedom";
import { COMMON_FEED_PATHS, discoverFeedLinks, looksLikeFeed, parseFeed } from "./feed.ts";
import { FetchError, type Fetcher } from "./safe-fetch.ts";
import { cleanText } from "./blocks.ts";
import { canonicalizeUrl, parseYouTubeUrl, publisherKeyForUrl, youTubeVideoUrl } from "./url.ts";
import type { YouTubeClient } from "./youtube.ts";

export interface DetectedSource {
  /** Detection finds feeds, pages and channels; newsletters only arrive by email. */
  type: Exclude<SourceType, "newsletter">;
  canonicalKey: string;
  inputUrl: string;
  /** Feed URL, page URL, or the YouTube uploads playlist ID. */
  fetchUrl: string;
  title: string;
  creator: string | null;
  publisher: { key: string; name: string; feedUrl: string | null };
}

export type DetectionFailure = "invalid_url" | "unreachable" | "not_supported" | "youtube_unavailable";

export class SourceDetectionError extends Error {
  readonly reason: DetectionFailure;

  constructor(reason: DetectionFailure, message: string) {
    super(message);
    this.name = "SourceDetectionError";
    this.reason = reason;
  }
}

export interface DetectDeps {
  fetch: Fetcher;
  youtube: YouTubeClient | null;
}

/** Accepts what people paste: bare domains, URLs with tracking junk, feed URLs, YouTube links. */
export function normalizeInput(raw: string): URL {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SourceDetectionError("invalid_url", "That doesn't look like a link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceDetectionError("invalid_url", "Only http and https links are supported");
  }
  if (!url.hostname.includes(".")) throw new SourceDetectionError("invalid_url", "That doesn't look like a link");
  return url;
}

/**
 * Works out what a pasted URL is (build plan §7, POST /me/sources):
 * a YouTube channel or video, a feed, a site with a feed, or a single page.
 */
export async function detectSource(raw: string, deps: DetectDeps): Promise<DetectedSource> {
  const input = normalizeInput(raw);
  const yt = parseYouTubeUrl(input);
  if (yt) return detectYouTube(input.toString(), yt, deps.youtube);

  let page;
  try {
    // Fetch the canonical form: no tracking parameters pinged on the user's behalf.
    page = await deps.fetch(canonicalizeUrl(input), { accept: "application/rss+xml,application/atom+xml,text/html;q=0.9,*/*;q=0.5" });
  } catch (err) {
    const message = err instanceof FetchError && err.reason === "blocked_address" ? "That address isn't allowed" : "We couldn't reach that link";
    throw new SourceDetectionError("unreachable", message);
  }
  // Paywalls and bot walls: keep the link; extraction records it as metadata-only (access_denied).
  if (page.status === 401 || page.status === 402 || page.status === 403) {
    const key = publisherKeyForUrl(page.url);
    return {
      type: "url",
      canonicalKey: canonicalizeUrl(page.url),
      inputUrl: raw.trim(),
      fetchUrl: page.url,
      title: page.url,
      creator: null,
      publisher: { key, name: key, feedUrl: null },
    };
  }
  if (page.status >= 400) throw new SourceDetectionError("unreachable", `That link returned an error (${page.status})`);

  // A feed URL, pasted directly.
  if (looksLikeFeed(page.contentType, page.body)) {
    const feed = parseFeed(page.body, page.url);
    if (!feed) throw new SourceDetectionError("not_supported", "That feed couldn't be read");
    const feedUrl = canonicalizeUrl(page.url);
    const siteUrl = feed.siteUrl ?? page.url;
    const key = publisherKeyForUrl(siteUrl);
    return {
      type: "feed",
      canonicalKey: feedUrl,
      inputUrl: raw.trim(),
      fetchUrl: page.url,
      title: feed.title ?? key,
      creator: null,
      publisher: { key, name: feed.title ?? key, feedUrl: page.url },
    };
  }

  if (!page.contentType.toLowerCase().includes("html")) {
    throw new SourceDetectionError("not_supported", "Only web pages, feeds and YouTube links are supported");
  }

  const { document } = parseHTML(page.body);
  const ogType = document.querySelector("meta[property='og:type']")?.getAttribute("content")?.toLowerCase() ?? null;
  const siteName = cleanText(document.querySelector("meta[property='og:site_name']")?.getAttribute("content")) || null;
  const pageTitle = cleanText(document.querySelector("title")?.textContent) || null;
  const key = publisherKeyForUrl(page.url);
  const isHome = new URL(page.url).pathname.replace(/\/+$/, "") === "";

  let feedUrl: string | null = null;
  let feedTitle: string | null = null;
  const candidates = discoverFeedLinks(page.body, page.url);
  // Only probe guessed paths for a homepage; for an article we'd just be guessing on someone's server.
  if (!candidates.length && isHome) {
    for (const path of COMMON_FEED_PATHS) candidates.push(new URL(path, page.url).toString());
  }
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const res = await deps.fetch(candidate, { accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9" });
      if (res.status >= 400 || !looksLikeFeed(res.contentType, res.body)) continue;
      const feed = parseFeed(res.body, res.url);
      if (!feed) continue;
      feedUrl = res.url;
      feedTitle = feed.title;
      break;
    } catch {
      // Try the next candidate.
    }
  }

  const publisher = { key, name: siteName ?? feedTitle ?? key, feedUrl };

  // A homepage or section page with a feed: follow the feed.
  if (feedUrl && (isHome || ogType !== "article")) {
    return {
      type: "feed",
      canonicalKey: canonicalizeUrl(feedUrl),
      inputUrl: raw.trim(),
      fetchUrl: feedUrl,
      title: feedTitle ?? siteName ?? pageTitle ?? key,
      creator: null,
      publisher,
    };
  }

  // A single article: ingest it once. Its publisher's feed (if any) is recorded for later.
  return {
    type: "url",
    canonicalKey: canonicalizeUrl(page.url),
    inputUrl: raw.trim(),
    fetchUrl: page.url,
    title: pageTitle ?? page.url,
    creator: null,
    publisher,
  };
}

async function detectYouTube(inputUrl: string, ref: NonNullable<ReturnType<typeof parseYouTubeUrl>>, youtube: YouTubeClient | null) {
  if (!youtube) throw new SourceDetectionError("youtube_unavailable", "YouTube sources aren't set up yet");

  if (ref.kind === "video") {
    const video = await youtube.getVideo(ref.videoId);
    if (!video) throw new SourceDetectionError("unreachable", "That video couldn't be found");
    const url = youTubeVideoUrl(video.videoId);
    return {
      type: "url",
      canonicalKey: url,
      inputUrl,
      fetchUrl: url,
      title: video.title,
      creator: video.channelTitle || null,
      publisher: { key: `youtube:${video.channelId}`, name: video.channelTitle || video.channelId, feedUrl: null },
    } satisfies DetectedSource;
  }

  const channel = await youtube.resolveChannel(ref);
  if (!channel) throw new SourceDetectionError("unreachable", "That channel couldn't be found");
  return {
    type: "youtube_channel",
    canonicalKey: `youtube:${channel.channelId}`,
    inputUrl,
    fetchUrl: channel.uploadsPlaylistId,
    title: channel.title,
    creator: channel.title,
    publisher: { key: `youtube:${channel.channelId}`, name: channel.title, feedUrl: null },
  } satisfies DetectedSource;
}

/** At most this many URLs are fetched to find a discovered publisher's feed. */
export const MAX_FEED_PROBES = 6;

/**
 * Finds a publisher's feed from one of its pages (build plan §6.3a): feeds the
 * page advertises with `<link rel="alternate">`, then those its homepage
 * advertises, then a few common paths. Each candidate is fetched and must
 * parse as a feed. At most MAX_FEED_PROBES fetches, all on the same site and
 * through the given (SSRF-safe) fetcher. Null when there's none.
 */
export async function autodetectFeed(page: { body: string; url: string }, fetch: Fetcher): Promise<{ feedUrl: string; title: string | null } | null> {
  let probes = 0;
  const host = new URL(page.url).host;
  const tried = new Set<string>();
  const tryFeed = async (url: string) => {
    if (probes >= MAX_FEED_PROBES || tried.has(url) || new URL(url).host !== host) return null;
    tried.add(url);
    probes++;
    try {
      const res = await fetch(url, { accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9" });
      if (res.status >= 400 || !looksLikeFeed(res.contentType, res.body)) return null;
      const feed = parseFeed(res.body, res.url);
      return feed ? { feedUrl: res.url, title: feed.title } : null;
    } catch {
      return null;
    }
  };

  for (const url of discoverFeedLinks(page.body, page.url).slice(0, 2)) {
    const found = await tryFeed(url);
    if (found) return found;
  }

  const home = new URL("/", page.url).toString();
  if (home !== page.url && probes < MAX_FEED_PROBES) {
    probes++;
    try {
      const res = await fetch(home);
      if (res.status < 400 && res.contentType.toLowerCase().includes("html")) {
        for (const url of discoverFeedLinks(res.body, res.url).slice(0, 2)) {
          const found = await tryFeed(url);
          if (found) return found;
        }
      }
    } catch {
      // Fall through to the common paths.
    }
  }

  for (const path of COMMON_FEED_PATHS) {
    const found = await tryFeed(new URL(path, page.url).toString());
    if (found) return found;
  }
  return null;
}
