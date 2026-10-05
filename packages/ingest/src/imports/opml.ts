import { XMLParser } from "fast-xml-parser";
import { cleanText } from "../blocks.ts";
import { resolveUrl } from "../url.ts";
import { type FoundSource, foundFeed, foundSite, foundYouTubeChannel } from "./found.ts";

/**
 * OPML, as exported by Feedly, Inoreader, Readwise Reader, NetNewsWire,
 * Apple Podcasts, Overcast and most other readers: `<outline xmlUrl htmlUrl
 * text title>` entries, possibly nested in folder outlines.
 */

export class OpmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpmlError";
  }
}

export interface OpmlResult {
  /** The document's `<head><title>`. */
  title: string | null;
  found: FoundSource[];
  /** Outlines that weren't folders but had no usable http(s) link. */
  skipped: number;
}

/** Outlines visited at most; a pathological file can't make us walk forever. */
const MAX_OUTLINES = 20_000;
const MAX_DEPTH = 32;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Only the predefined entities (and HTML ones in titles); a DOCTYPE is refused before parsing.
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === "outline",
});

/** Parses an OPML document into sources to offer. Throws OpmlError when it isn't OPML at all. */
export function parseOpml(xml: string, { maxBytes = 2 * 1024 * 1024 }: { maxBytes?: number } = {}): OpmlResult {
  if (Buffer.byteLength(xml, "utf8") > maxBytes) throw new OpmlError(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB`);
  // No DTDs: internal entity definitions are how XML bombs work, and OPML never needs them.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new OpmlError("That file uses XML features OPML doesn't need (a DOCTYPE)");

  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new OpmlError("That file isn't valid OPML");
  }
  const opml = doc?.opml;
  if (!opml || typeof opml !== "object") throw new OpmlError("That file isn't OPML (no <opml> element)");
  const body = Array.isArray(opml.body) ? opml.body[0] : opml.body;
  const head = Array.isArray(opml.head) ? opml.head[0] : opml.head;

  const found: FoundSource[] = [];
  let skipped = 0;
  let visited = 0;

  const walk = (outlines: unknown, folder: string | null, depth: number) => {
    if (!Array.isArray(outlines) || depth > MAX_DEPTH) return;
    for (const raw of outlines) {
      if (++visited > MAX_OUTLINES) return;
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const attr = (name: string) => attribute(o, name);
      const title = cleanText(attr("title") ?? attr("text") ?? "") || null;
      const xmlUrl = link(attr("xmlUrl") ?? attr("url"));
      const htmlUrl = link(attr("htmlUrl"));
      const children = o.outline;

      if (xmlUrl) {
        const channelId = youTubeFeedChannel(xmlUrl);
        if (channelId) found.push(foundYouTubeChannel(channelId, title ?? "YouTube channel", folder));
        else {
          found.push(foundFeed(xmlUrl, { title: title ?? hostOf(htmlUrl ?? xmlUrl), detail: hostOf(htmlUrl ?? xmlUrl), group: folder, siteUrl: htmlUrl }));
        }
      } else if (htmlUrl) {
        found.push(foundSite(htmlUrl, { title: title ?? hostOf(htmlUrl), detail: hostOf(htmlUrl), group: folder }));
      } else if (!Array.isArray(children)) {
        skipped++;
      }
      // A folder (or, rarely, a feed with children): walk in, naming the group after the nearest folder.
      if (Array.isArray(children)) walk(children, xmlUrl || htmlUrl ? folder : (title ?? folder), depth + 1);
    }
  };
  walk(body?.outline, null, 0);

  const headTitle = head && typeof head === "object" ? cleanText(String((head as Record<string, unknown>).title ?? "")) || null : null;
  return { title: headTitle, found, skipped };
}

/** Attribute lookup that ignores case: some exporters write `xmlurl` or `XMLURL`. */
function attribute(o: Record<string, unknown>, name: string): string | null {
  const want = `@${name.toLowerCase()}`;
  for (const [k, v] of Object.entries(o)) {
    if (k.toLowerCase() === want && (typeof v === "string" || typeof v === "number")) return String(v).trim() || null;
  }
  return null;
}

function link(value: string | null): string | null {
  if (!value) return null;
  // Some exports write feed:// or omit the scheme; only http(s) is followed.
  const fixed = value.replace(/^feed:\/\//i, "https://").replace(/^feed:/i, "");
  const url = resolveUrl(fixed, "https://invalid.invalid/");
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname === "invalid.invalid" || !parsed.hostname.includes(".")) return null;
  return url;
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (what YouTube exports) → the channel ID. */
function youTubeFeedChannel(url: string): string | null {
  const u = new URL(url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname !== "/feeds/videos.xml") return null;
  const id = u.searchParams.get("channel_id");
  return id && /^UC[\w-]{22}$/.test(id) ? id : null;
}
