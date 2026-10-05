import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { countWords } from "@fs/core";
import type { Block, Section, UnavailableReason } from "@fs/schema";
import { parseHTML } from "linkedom";
import { blocksToText, buildSections, cleanText, htmlToBlocks } from "./blocks.ts";
import { simhash64 } from "./simhash.ts";
import { resolveUrl } from "./url.ts";

export interface PageMetadata {
  title: string | null;
  siteName: string | null;
  byline: string | null;
  publishedAt: Date | null;
  language: string | null;
  /** From `<link rel=canonical>` or `og:url`. */
  canonicalUrl: string | null;
  /** og:image, twitter:image or JSON-LD image; extraction falls back to the article's first image. */
  leadImageUrl: string | null;
}

export interface ExtractedArticle {
  metadata: PageMetadata;
  blocks: Block[];
  sections: Section[];
  text: string;
  wordCount: number;
  excerpt: string | null;
  contentHash: string;
  simhash: bigint | null;
  /** Set when there's no usable body; the item becomes metadata-only. */
  unavailableReason: UnavailableReason | null;
}

/**
 * Below this, extraction found essentially nothing. Kept low on purpose: some
 * writers publish complete 30-word posts. Teasers are caught by the paywall
 * signals instead.
 */
export const MIN_ARTICLE_WORDS = 20;
/** A page that signals a paywall and has less text than this is treated as truncated. */
const PAYWALL_TRUNCATION_WORDS = 600;

const PAYWALL_SELECTORS = [
  "[class*='paywall' i]",
  "[id*='paywall' i]",
  "[class*='regwall' i]",
  "[class*='subscriber-only' i]",
  "[class*='premium-content' i]",
  "[class*='piano' i]",
  ".tp-modal",
  "[data-paywall]",
].join(",");

/** Extracts article text as block JSON. Pure: no network access. */
export function extractArticle(html: string, pageUrl: string): ExtractedArticle {
  const { document } = parseHTML(html);
  const metadata = readMetadata(document, pageUrl);
  const paywallSignal = hasPaywallSignal(document);

  // Readability drops headings whose class or id looks like page chrome (e.g. Substack's
  // "header-anchor-post"), which loses every section title. Headings carry no chrome we need.
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    h.removeAttribute("class");
    h.removeAttribute("id");
  }

  // Readability mutates the document, so metadata and paywall checks go first.
  let blocks: Block[] = [];
  let readabilityTitle: string | null = null;
  try {
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 200 }).parse();
    if (article?.content) {
      const { document: content } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
      blocks = htmlToBlocks(content.body as never, pageUrl);
      readabilityTitle = cleanText(article.title) || null;
      metadata.byline ??= cleanText(article.byline) || null;
      metadata.siteName ??= cleanText(article.siteName) || null;
    }
  } catch {
    blocks = [];
  }

  // Readability often keeps the title as the first heading; the Reader shows it separately.
  metadata.leadImageUrl ??= (blocks.find((b) => b.type === "image") as { src: string } | undefined)?.src ?? null;

  const title = metadata.title ?? readabilityTitle;
  if (blocks[0]?.type === "heading" && title && blocks[0].text === title) blocks = blocks.slice(1);
  metadata.title = title;

  const text = blocksToText(blocks);
  const wordCount = countWords(text);

  let unavailableReason: UnavailableReason | null = null;
  if (paywallSignal && wordCount < PAYWALL_TRUNCATION_WORDS) unavailableReason = "paywalled";
  else if (wordCount < MIN_ARTICLE_WORDS) unavailableReason = "too_short";

  return {
    metadata,
    blocks: unavailableReason ? [] : blocks,
    sections: unavailableReason ? [] : buildSections(blocks),
    text: unavailableReason ? "" : text,
    wordCount,
    excerpt: unavailableReason ? null : makeExcerpt(blocks),
    contentHash: hashBlocks(unavailableReason ? [] : blocks),
    simhash: unavailableReason ? null : simhash64(text),
    unavailableReason,
  };
}

export function hashBlocks(blocks: readonly Block[]): string {
  return createHash("sha256").update(JSON.stringify(blocks)).digest("hex");
}

/** The first paragraphs, cut at a word near `maxChars`. */
export function makeExcerpt(blocks: readonly Block[], maxChars = 320): string | null {
  const text = blocks
    .filter((b) => b.type === "paragraph")
    .map((b) => (b as { text: string }).text)
    .join(" ");
  if (!text) return null;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), maxChars - 40))}…`;
}

type Doc = ReturnType<typeof parseHTML>["document"];

function meta(document: Doc, ...names: string[]): string | null {
  for (const name of names) {
    const el = document.querySelector(`meta[property='${name}'], meta[name='${name}'], meta[itemprop='${name}']`);
    const value = cleanText(el?.getAttribute("content"));
    if (value) return value;
  }
  return null;
}

function readJsonLd(document: Doc): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
    try {
      const parsed = JSON.parse(script.textContent ?? "");
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        out.push(node);
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
      }
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  return out;
}

function readMetadata(document: Doc, pageUrl: string): PageMetadata {
  const jsonLd = readJsonLd(document);
  const article = jsonLd.find((n) => /Article|BlogPosting|NewsArticle|Report/.test(String(n["@type"] ?? "")));

  const canonicalHref = document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? meta(document, "og:url");
  const published =
    meta(document, "article:published_time", "datePublished", "pubdate", "date") ??
    (typeof article?.datePublished === "string" ? article.datePublished : null) ??
    document.querySelector("time[datetime]")?.getAttribute("datetime") ??
    null;
  const publishedAt = published ? new Date(published) : null;

  const authorFromLd = (() => {
    const a = article?.author;
    const first = Array.isArray(a) ? a[0] : a;
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string") {
      return (first as { name: string }).name;
    }
    return null;
  })();

  const ldImage = (() => {
    const img = article?.image;
    const first = Array.isArray(img) ? img[0] : img;
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof (first as { url?: unknown }).url === "string") return (first as { url: string }).url;
    return null;
  })();
  const image = meta(document, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src") ?? ldImage;

  return {
    title: meta(document, "og:title", "twitter:title") ?? (cleanText(document.querySelector("title")?.textContent) || null),
    siteName: meta(document, "og:site_name", "application-name"),
    byline: meta(document, "author", "article:author") ?? authorFromLd,
    publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    language: cleanText(document.documentElement?.getAttribute("lang")).split(/[-_]/)[0]?.toLowerCase() || null,
    canonicalUrl: canonicalHref ? resolveUrl(canonicalHref, pageUrl) : null,
    leadImageUrl: httpUrl(image, pageUrl),
  };
}

/** An absolute http(s) URL, or null (data: URIs, tracking pixels and junk are dropped). */
function httpUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  const url = resolveUrl(href, base);
  if (!url || !/^https?:\/\//i.test(url) || url.length > 2_000) return null;
  return url;
}

function hasPaywallSignal(document: Doc): boolean {
  for (const node of readJsonLd(document)) {
    const free = node.isAccessibleForFree;
    if (free === false || String(free).toLowerCase() === "false") return true;
  }
  const tier = meta(document, "article:content_tier");
  if (tier && tier.toLowerCase() !== "free") return true;
  return document.querySelector(PAYWALL_SELECTORS) !== null;
}
