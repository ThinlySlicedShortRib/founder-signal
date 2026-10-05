import { createHash } from "node:crypto";
import { countWords } from "@fs/core";
import type { Block, Section } from "@fs/schema";
import { parseHTML } from "linkedom";
import { blocksToText, blockText, buildSections, cleanText, htmlToBlocks } from "../blocks.ts";
import { hashBlocks, makeExcerpt, MIN_ARTICLE_WORDS } from "../extract.ts";
import { simhash64 } from "../simhash.ts";
import { canonicalizeUrl } from "../url.ts";

/** A newsletter's body as an article: the same shape extraction produces for a web page. */
export interface NewsletterArticle {
  blocks: Block[];
  sections: Section[];
  text: string;
  wordCount: number;
  excerpt: string | null;
  contentHash: string;
  simhash: bigint | null;
  leadImageUrl: string | null;
  /** Too little text to be a piece (under MIN_ARTICLE_WORDS). */
  tooShort: boolean;
}

type Doc = ReturnType<typeof parseHTML>["document"];
type El = ReturnType<Doc["querySelector"]> & {};

/** Never content: removed with everything inside. */
const DROP = "script,style,noscript,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,svg,math,head,meta,link,title,base,template,audio,video,canvas,map,area";
/** Inline styles that hide something (preheaders, Outlook-only blocks). */
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|max-height\s*:\s*0(px)?\s*(;|$)|font-size\s*:\s*0(px)?\s*(;|$)|opacity\s*:\s*0(\.0+)?\s*(;|$)/i;
/** Images that are open trackers or spacers, by URL. */
const TRACKING_IMAGE = /(\/open(\.aspx|\.gif|\.php)?([/?]|$)|\/o\/|\/e\/o\/|\/wf\/open|pixel|beacon|\/track(ing)?\/|\/t\.gif|spacer|blank\.gif|transparent\.(gif|png)|\/1x1)/i;
/** Footer and chrome lines: unsubscribe, preferences, "view in browser", share buttons, legal lines. */
const BOILERPLATE =
  /unsubscribe|manage (your )?(subscription|preferences|email settings)|update (your )?(email )?preferences|email preferences|(view|read|open) (this )?(email|post|issue|newsletter|it)? ?(in|on) (your |a |the )?(browser|web|app)|you('re| are) receiving this|you (signed|subscribed) up|this email was sent to|sent to [^\s]+@|no longer (wish|want) to receive|forwarded this (email|newsletter)|was this (email )?forwarded to you|subscribe (here|now|for free)|all rights reserved|^(©|&copy;|\(c\))\s*\d{4}|^read online$|^view online$|^web version$|our mailing address|privacy policy|powered by (beehiiv|substack|mailchimp|convertkit|kit|ghost|buttondown)|get the app|start writing|share this post|read in app|open in app|upgrade to paid|refer a friend|add us to your (address book|contacts)/i;
/** Whole short paragraphs that are only buttons (Substack's "Like Comment Restack", "Share"). */
const BUTTON_ONLY = /^((like|comment|restack|share|subscribe|reply|forward|listen|read more|continue reading|read the full (story|post|article|breakdown|issue)|upgrade|donate)[\s·|•:→›»]*)+$/i;

/**
 * Turns a newsletter's HTML (or plain text, when there's no HTML) into
 * blocks. Email HTML is table soup, so layout tables are unwrapped first;
 * hidden preheaders, tracking pixels, buttons and footer boilerplate are
 * removed. The blocks keep only text and image URLs, so nothing executable
 * can survive. Pure: no network access.
 */
export function newsletterToArticle({ html, text, title }: { html: string | null; text: string | null; title: string | null }): NewsletterArticle {
  let blocks = html ? htmlNewsletterBlocks(html) : [];
  if (countWords(blocksToText(blocks)) < MIN_ARTICLE_WORDS && text) blocks = textToBlocks(text);
  blocks = tidyBlocks(blocks, title);

  const body = blocksToText(blocks);
  const wordCount = countWords(body);
  const tooShort = wordCount < MIN_ARTICLE_WORDS;
  return {
    blocks: tooShort ? [] : blocks,
    sections: tooShort ? [] : buildSections(blocks),
    text: tooShort ? "" : body,
    wordCount,
    excerpt: tooShort ? null : makeExcerpt(blocks),
    contentHash: hashBlocks(tooShort ? [] : blocks),
    simhash: tooShort ? null : simhash64(body),
    leadImageUrl: (blocks.find((b) => b.type === "image") as { src: string } | undefined)?.src ?? null,
    tooShort,
  };
}

function htmlNewsletterBlocks(html: string): Block[] {
  const { document } = parseHTML(html.includes("<body") ? html : `<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  if (!body) return [];
  for (const el of [...body.querySelectorAll(DROP)]) el.remove();
  for (const el of [...body.querySelectorAll("[style], [hidden], [aria-hidden], [class]")]) {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || /\b(preheader|preview-?text)\b/i.test(el.getAttribute("class") ?? "") || HIDDEN_STYLE.test(el.getAttribute("style") ?? "")) {
      el.remove();
    }
  }
  for (const img of [...body.querySelectorAll("img")]) if (isTrackingOrSpacer(img)) img.remove();
  removeBoilerplate(body);
  unwrapLayoutTables(body);
  return htmlToBlocks(body as never, "https://invalid.example/");
}

function isTrackingOrSpacer(img: El): boolean {
  const src = img.getAttribute("src") ?? "";
  if (!/^https?:\/\//i.test(src)) return true;
  const size = (name: "width" | "height") => {
    const attr = Number.parseInt(img.getAttribute(name) ?? "", 10);
    const style = (img.getAttribute("style") ?? "").match(new RegExp(`(^|;|\\s)${name}\\s*:\\s*(\\d+)px`, "i"))?.[2];
    return Number.isFinite(attr) ? attr : style ? Number(style) : null;
  };
  const w = size("width");
  const h = size("height");
  // 1×1 pixels, spacers, and icons (social buttons, logos in footers) under 40px.
  if ((w !== null && w <= 40) || (h !== null && h <= 3)) return true;
  // Mastheads: a logo isn't the piece's picture.
  if (/logo/i.test(src) || /\blogo\b/i.test(img.getAttribute("alt") ?? "")) return true;
  return TRACKING_IMAGE.test(src);
}

/**
 * Removes the smallest blocks whose text is footer or chrome: a paragraph,
 * cell or list item with an unsubscribe link, "view in browser", share
 * buttons. Only short ones, so a long paragraph that mentions "subscribe" stays.
 */
function removeBoilerplate(body: El) {
  for (const el of [...body.querySelectorAll("p, li, td, th, h1, h2, h3, h4, h5, h6, div, span, a")]) {
    if (!el.isConnected) continue;
    // Leaves only: an element holding other blocks is judged by its children.
    if (el.querySelector("p, li, td, div, table, h1, h2, h3, h4, h5, h6")) continue;
    const text = cleanText(el.textContent);
    if (!text) continue;
    if ((text.length < 400 && BOILERPLATE.test(text)) || (text.length < 60 && BUTTON_ONLY.test(text))) {
      // A link inside a short line takes the line with it; inside a long paragraph, only the link goes.
      const line = el.tagName === "A" || el.tagName === "SPAN" ? el.closest("p, li, td, div") : null;
      (line && cleanText(line.textContent).length < 400 ? line : el).remove();
    }
  }
}

/**
 * Email layout tables become plain containers, so their cells are read as
 * paragraphs rather than one giant table block. A table stays a table only
 * when it looks like data: header cells, or several rows and columns of
 * short text with nothing block-level inside.
 */
function unwrapLayoutTables(body: El) {
  const tables = [...body.querySelectorAll("table")];
  const layout = new Set(tables.filter((t) => !isDataTable(t)));
  for (const table of layout) {
    for (const cell of [...table.querySelectorAll("td, th")]) if (cell.closest("table") === table) rename(cell, "div");
    for (const row of [...table.querySelectorAll("tr")]) if (row.closest("table") === table) rename(row, "div");
    for (const part of [...table.querySelectorAll("tbody, thead, tfoot")]) if (part.closest("table") === table) rename(part, "div");
    rename(table, "div");
  }
}

function isDataTable(table: El): boolean {
  if (table.getAttribute("role") === "presentation") return false;
  const rows = [...table.querySelectorAll("tr")].filter((r) => r.closest("table") === table);
  const cells = rows.flatMap((r) => [...r.children].filter((c) => c.tagName === "TD" || c.tagName === "TH"));
  if (cells.some((c) => c.querySelector("p, div, table, h1, h2, h3, h4, h5, h6, img, ul, ol, blockquote"))) return false;
  if (cells.some((c) => c.tagName === "TH")) return true;
  const cols = Math.max(0, ...rows.map((r) => [...r.children].length));
  return rows.length >= 2 && cols >= 2 && cells.every((c) => cleanText(c.textContent).length <= 200);
}

function rename(el: El, tag: string) {
  const replacement = el.ownerDocument.createElement(tag);
  while (el.firstChild) replacement.appendChild(el.firstChild);
  el.replaceWith(replacement);
}

/** Plain-text newsletters: blank lines separate paragraphs; runs of `-`/`*`/`•` lines are lists. */
export function textToBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every((l) => /^[-*•]\s+/.test(l))) {
      blocks.push({ type: "list", ordered: false, items: lines.map((l) => cleanText(l.replace(/^[-*•]\s+/, ""))) });
    } else if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      blocks.push({ type: "list", ordered: true, items: lines.map((l) => cleanText(l.replace(/^\d+[.)]\s+/, ""))) });
    } else if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0]!)) {
      blocks.push({ type: "heading", level: 2, text: cleanText(lines[0]!.replace(/^#+\s+/, "")) });
    } else {
      blocks.push({ type: "paragraph", text: cleanText(lines.join(" ")) });
    }
  }
  return blocks;
}

/** Drops the title repeated at the top, repeated paragraphs, and boilerplate that survived as its own block. */
function tidyBlocks(blocks: Block[], title: string | null): Block[] {
  const out: Block[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const text = blockText(b);
    if (b.type !== "image" && !text) continue;
    if ((b.type === "paragraph" || b.type === "heading" || b.type === "caption") && text.length < 400 && (BOILERPLATE.test(text) || BUTTON_ONLY.test(text))) continue;
    // The subject usually reappears near the top as a heading; the reader shows the title itself.
    if (out.length < 3 && title && (b.type === "heading" || b.type === "paragraph") && sameWords(text, title)) continue;
    const key = b.type === "image" ? `img:${b.src}` : `${b.type}:${text}`;
    if (seen.has(key) && (b.type === "image" || text.length < 200)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/** Same words, ignoring case, punctuation and emoji. */
function sameWords(a: string, b: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return words(a) === words(b);
}

// ── Links ────────────────────────────────────────────────────────────────────

/** Query parameters that redirectors commonly carry their target in. */
const TARGET_PARAMS = /^(url|u|redirect|redirect_url|redirect_uri|target|link|dest|destination|to|goto|q|r)$/i;

/**
 * A tracked link's target when it can be read without following it: a
 * target URL in a query parameter (`…?url=https://…`) or a base64url path
 * segment that decodes to one (ConvertKit/Kit, some others). Otherwise the
 * link itself. Never touches the network.
 */
export function decodeTrackedLink(href: string, depth = 0): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (depth > 2) return href;
  for (const [key, value] of url.searchParams) {
    if (TARGET_PARAMS.test(key) && /^https?:\/\/[^\s]+$/i.test(value)) return decodeTrackedLink(value, depth + 1);
  }
  for (const segment of url.pathname.split("/")) {
    if (segment.length < 16 || !/^[A-Za-z0-9_-]+={0,2}$/.test(segment)) continue;
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    if (/^https?:\/\/[\x21-\x7e]+$/.test(decoded)) return decodeTrackedLink(decoded, depth + 1);
  }
  return href;
}

/** Redirect links we can't decode (the target is only known to the sender's server). */
function isOpaqueRedirect(url: URL): boolean {
  return (
    /^(link|links|click|clicks|track|trk|email|e|r|t)\./i.test(url.hostname) ||
    /\/(redirect|track\/click|ss\/c|CL0|ls\/click|wf\/click)\//i.test(url.pathname)
  );
}

const WEB_VERSION_TEXT = /^(view|read|open|see)\b.{0,30}\b(browser|online|web|website|substack)\b|^(web|online|browser) version$|^read online$/i;
const POST_PATH = /^\/p\/[^/?#]+/;

/**
 * The newsletter's web version, canonicalized, when the email links to it:
 * `List-Post` if it's a web URL, a "View in browser"/"Read online" link, a
 * "View this post on the web at …" line in the text, or a post link
 * (`/p/<slug>`, as Substack and Beehiiv use) around the title or repeated in
 * the body. Tracked links are decoded only when that needs no request.
 * Null when there's none (the item then gets a synthetic `newsletter://` key).
 */
export function findWebVersionUrl({ html, text, listPost, title }: { html: string | null; text: string | null; listPost: string | null; title: string | null }): string | null {
  const usable = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try {
      let url = new URL(decodeTrackedLink(href.trim()));
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (isOpaqueRedirect(url)) return null;
      // open.substack.com/pub/<name>/p/<slug> is the app's link to <name>.substack.com/p/<slug>.
      const open = url.hostname === "open.substack.com" && url.pathname.match(/^\/pub\/([^/]+)\/p\/([^/?#]+)/);
      if (open) url = new URL(`https://${open[1]}.substack.com/p/${open[2]}`);
      return canonicalizeUrl(url);
    } catch {
      return null;
    }
  };

  const fromHeader = usable(listPost);
  if (fromHeader) return fromHeader;

  const links: { href: string; text: string }[] = [];
  if (html) {
    const { document } = parseHTML(html.includes("<body") ? html : `<!doctype html><html><body>${html}</body></html>`);
    for (const a of document.querySelectorAll("a[href]")) links.push({ href: a.getAttribute("href") ?? "", text: cleanText(a.textContent) });
  }
  for (const link of links) {
    if (WEB_VERSION_TEXT.test(link.text)) {
      const url = usable(link.href);
      if (url) return url;
    }
  }
  const inText = text?.match(/(?:view|read) (?:this|it|the) (?:post|email|issue)?\s*(?:on the web|online|in (?:your|a) browser)[^\n]*?(https?:\/\/\S+)/i)?.[1];
  const textUrl = usable(inText?.replace(/[)>\].,]+$/, ""));
  if (textUrl) return textUrl;

  const posts = links.map((l) => ({ ...l, url: usable(l.href) })).filter((l): l is typeof l & { url: string } => !!l.url && POST_PATH.test(new URL(l.url).pathname));
  const titled = title ? posts.find((p) => p.text.toLowerCase() === title.toLowerCase()) : undefined;
  if (titled) return titled.url;
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.url, (counts.get(p.url) ?? 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 2 ? top[0] : null;
}

/** A stable key for a newsletter with no web version: one per message. */
export function syntheticNewsletterUrl(parts: { messageId: string | null; from: string | null; subject: string | null; date: Date | null; text: string }): string {
  const basis = parts.messageId ?? `${parts.from}|${parts.subject}|${parts.date?.toISOString()}|${parts.text.slice(0, 2_000)}`;
  return `newsletter://${createHash("sha256").update(basis).digest("hex").slice(0, 40)}`;
}
