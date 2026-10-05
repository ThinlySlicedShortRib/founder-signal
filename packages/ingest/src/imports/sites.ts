import { discoverFeedLinks, looksLikeFeed } from "../feed.ts";
import type { Fetcher } from "../safe-fetch.ts";

export interface SiteFeedOptions {
  /** Sites checked at most; the rest are left unchecked. */
  max?: number;
  concurrency?: number;
  /** Whatever isn't done by then is left unchecked, so an import never waits long. */
  deadlineMs?: number;
}

/**
 * A quick look for each website's feed while an import is being listed: one
 * fetch of the page (through the SSRF-safe fetcher) and its advertised
 * `<link rel="alternate">` feeds. Returns, per URL, the feed (or the URL
 * itself when it is a feed), null when there's none, and no entry when it
 * wasn't checked in time. The feed isn't fetched here: the worker validates
 * it on its first fetch. Adding a site that wasn't checked runs the full
 * detection then.
 */
export async function findSiteFeeds(urls: string[], fetch: Fetcher, { max = 60, concurrency = 6, deadlineMs = 12_000 }: SiteFeedOptions = {}) {
  const results = new Map<string, string | null>();
  const queue = [...new Set(urls)].slice(0, max);
  let done = false;

  const checkOne = async (url: string) => {
    try {
      const res = await fetch(url, { accept: "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml;q=0.9" });
      if (done) return;
      if (res.status >= 400) return void results.set(url, null);
      if (looksLikeFeed(res.contentType, res.body)) return void results.set(url, res.url);
      if (!res.contentType.toLowerCase().includes("html")) return void results.set(url, null);
      results.set(url, discoverFeedLinks(res.body, res.url)[0] ?? null);
    } catch {
      if (!done) results.set(url, null);
    }
  };

  const worker = async () => {
    for (let url = queue.shift(); url && !done; url = queue.shift()) await checkOne(url);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, deadlineMs))),
  ]);
  done = true;
  clearTimeout(timer);
  // Copy, so late answers from fetches still in flight can't change the result.
  return new Map(results);
}

/** Hosts that are profiles elsewhere, not someone's website with a feed. */
const NOT_A_WEBSITE = [
  "bsky.app",
  "twitter.com",
  "x.com",
  "instagram.com",
  "facebook.com",
  "linkedin.com",
  "threads.net",
  "threads.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "github.com",
  "gitlab.com",
  "linktr.ee",
  "patreon.com",
  "ko-fi.com",
  "buymeacoffee.com",
  "paypal.me",
  "discord.gg",
  "discord.com",
  "t.me",
  "twitch.tv",
  "mastodon.social",
  "keybase.io",
  "calendly.com",
  "bit.ly",
  "tinyurl.com",
  "shorturl.at",
  "lnk.to",
  "bio.site",
  "beacons.ai",
  "share.google",
  "app.google",
  "carrd.co",
  "msha.ke",
  "solo.to",
];

/** True for a URL worth checking for a feed: http(s), public, not a social profile. */
export function isWebsiteLink(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  return host.includes(".") && !NOT_A_WEBSITE.some((h) => host === h || host.endsWith(`.${h}`));
}
