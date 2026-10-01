import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { resolveUrl } from "./url.ts";

export interface FeedEntry {
  url: string;
  title: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** The entry's `<guid>`/`<id>`, when present. */
  guid: string | null;
}

export interface Feed {
  title: string | null;
  /** The site the feed belongs to. */
  siteUrl: string | null;
  entries: FeedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  textNodeName: "#text",
  // Entity expansion is a classic XML bomb vector; feeds only need the predefined entities.
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link"].includes(name),
});

/** Parses RSS 2.0, RSS 1.0 (RDF) or Atom. Returns null if the document isn't a feed. */
export function parseFeed(xml: string, feedUrl: string): Feed | null {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  if (doc.rss?.channel) {
    const channel = first(doc.rss.channel);
    return {
      title: text(channel.title),
      siteUrl: resolveMaybe(textOfLinks(channel.link), feedUrl),
      entries: toEntries(channel.item, feedUrl, (item) => ({
        link: textOfLinks(item.link) ?? (item.guid?.["@isPermaLink"] !== "false" ? text(item.guid) : null),
        title: text(item.title),
        author: text(item.creator) ?? text(item.author),
        date: text(item.pubDate) ?? text(item.date),
        guid: text(item.guid),
      })),
    };
  }

  if (doc.RDF) {
    const channel = first(doc.RDF.channel) ?? {};
    return {
      title: text(channel.title),
      siteUrl: resolveMaybe(textOfLinks(channel.link), feedUrl),
      entries: toEntries(doc.RDF.item, feedUrl, (item) => ({
        link: textOfLinks(item.link),
        title: text(item.title),
        author: text(item.creator),
        date: text(item.date),
        guid: item["@about"] ?? null,
      })),
    };
  }

  if (doc.feed) {
    const feed = doc.feed;
    return {
      title: text(feed.title),
      siteUrl: resolveMaybe(atomLink(feed.link, "alternate"), feedUrl),
      entries: toEntries(feed.entry, feedUrl, (entry) => ({
        link: atomLink(entry.link, "alternate"),
        title: text(entry.title),
        author: text(first(entry.author)?.name),
        date: text(entry.published) ?? text(entry.updated),
        guid: text(entry.id),
      })),
    };
  }

  return null;
}

interface RawEntry {
  link: string | null;
  title: string | null;
  author: string | null;
  date: string | null;
  guid: string | null;
}

function toEntries(items: unknown, base: string, map: (item: any) => RawEntry): FeedEntry[] {
  const list = Array.isArray(items) ? items : items ? [items] : [];
  const entries: FeedEntry[] = [];
  for (const item of list) {
    const raw = map(item);
    const url = resolveMaybe(raw.link, base);
    if (!url) continue;
    const date = raw.date ? new Date(raw.date) : null;
    entries.push({
      url,
      title: raw.title,
      author: raw.author,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
      guid: raw.guid,
    });
  }
  return entries;
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function text(value: unknown): string | null {
  const v = first(value as unknown[]);
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v).trim() || null;
  if (typeof v === "object" && "#text" in v) return String((v as Record<string, unknown>)["#text"]).trim() || null;
  return null;
}

/** RSS `<link>` is text, but some feeds also include `<atom:link href>`; take the first text one. */
function textOfLinks(links: unknown): string | null {
  const list = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of list) {
    const t = text(link);
    if (t) return t;
  }
  return null;
}

function atomLink(links: unknown, rel: string): string | null {
  const list = (Array.isArray(links) ? links : links ? [links] : []) as Record<string, string>[];
  const match = list.find((l) => (l["@rel"] ?? "alternate") === rel) ?? list[0];
  return match?.["@href"] ?? null;
}

function resolveMaybe(href: string | null, base: string): string | null {
  return href ? resolveUrl(href, base) : null;
}

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/xml", "text/xml"]);

/** Feed URLs advertised by a page's `<link rel="alternate">`, best first. */
export function discoverFeedLinks(html: string, pageUrl: string): string[] {
  const { document } = parseHTML(html);
  const found: string[] = [];
  for (const link of document.querySelectorAll("link[rel~='alternate'][href]")) {
    const type = (link.getAttribute("type") ?? "").toLowerCase().split(";")[0]!.trim();
    if (!FEED_TYPES.has(type)) continue;
    const title = (link.getAttribute("title") ?? "").toLowerCase();
    // Comment feeds aren't what anyone wants to follow.
    if (title.includes("comment")) continue;
    const url = resolveUrl(link.getAttribute("href")!, pageUrl);
    if (url && !found.includes(url)) found.push(url);
  }
  return found;
}

/** Paths worth probing when a site doesn't advertise its feed. */
export const COMMON_FEED_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feed/"];

export function looksLikeFeed(contentType: string, body: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("rss") || type.includes("atom")) return true;
  if (!type.includes("xml") && !body.trimStart().startsWith("<?xml")) return false;
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2_000));
}
