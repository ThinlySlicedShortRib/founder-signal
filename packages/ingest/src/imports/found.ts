import { canonicalizeUrl, publisherKeyForUrl } from "../url.ts";

/**
 * Something an import found that could become a source (docs/imports/README.md).
 * `ready` ones know their feed or channel and are added as they are; `site`
 * ones only know a website, whose feed is looked for when they're added.
 */
export interface FoundSource {
  kind: "feed" | "youtube_channel";
  check: "ready" | "site";
  title: string;
  /** A second line for the checklist: the site's host, an @handle. */
  detail: string | null;
  /** Groups the checklist: an OPML folder, "People you follow", "Their websites". */
  group: string | null;
  /** The feed URL, the website (for `site`), or the channel's YouTube URL. */
  url: string;
  /** YouTube channels only. */
  channelId?: string;
  /** The catalog publisher it belongs to (a host, `youtube:<id>`, `bsky:<did>`, `mastodon:<acct>`). */
  publisher: { key: string; name: string };
}

/** Stable key for a found source: the same thing found twice (or already followed) gets the same key. */
export function foundSourceKey(found: Pick<FoundSource, "kind" | "check" | "url" | "channelId">): string {
  if (found.kind === "youtube_channel") return `youtube:${found.channelId}`;
  return found.check === "site" ? `site:${canonicalizeUrl(found.url)}` : canonicalizeUrl(found.url);
}

/** A feed found at a known URL; its publisher is the site's host unless given. */
export function foundFeed(
  url: string,
  { title, detail = null, group = null, siteUrl, publisher }: { title: string; detail?: string | null; group?: string | null; siteUrl?: string | null; publisher?: { key: string; name: string } },
): FoundSource {
  const key = publisherKeyForUrl(siteUrl ?? url);
  return { kind: "feed", check: "ready", title, detail, group, url, publisher: publisher ?? { key, name: title || key } };
}

/** A website whose feed is still to be found. */
export function foundSite(url: string, { title, detail = null, group = null }: { title: string; detail?: string | null; group?: string | null }): FoundSource {
  const key = publisherKeyForUrl(url);
  return { kind: "feed", check: "site", title, detail, group, url, publisher: { key, name: title || key } };
}

export function foundYouTubeChannel(channelId: string, title: string, group: string | null = null): FoundSource {
  return {
    kind: "youtube_channel",
    check: "ready",
    title,
    detail: "YouTube",
    group,
    url: `https://www.youtube.com/channel/${channelId}`,
    channelId,
    publisher: { key: `youtube:${channelId}`, name: title },
  };
}

/**
 * Drops repeats (by key, first one wins) and anything past `max`.
 * Returns what's kept, with keys, and how many were cut by the cap.
 */
export function dedupeFound(found: FoundSource[], max: number): { kept: (FoundSource & { key: string })[]; overCap: number } {
  const seen = new Set<string>();
  const kept: (FoundSource & { key: string })[] = [];
  let overCap = 0;
  for (const f of found) {
    let key: string;
    try {
      key = foundSourceKey(f);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length >= max) {
      overCap++;
      continue;
    }
    kept.push({ ...f, key });
  }
  return { kept, overCap };
}

/** Thrown by the handle importers with a message that can be shown as is. */
export class ImportFailure extends Error {
  readonly reason: "invalid_handle" | "not_found" | "hidden" | "unavailable";

  constructor(reason: ImportFailure["reason"], message: string) {
    super(message);
    this.name = "ImportFailure";
    this.reason = reason;
  }
}
