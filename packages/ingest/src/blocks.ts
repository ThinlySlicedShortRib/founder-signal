import type { Block, Section } from "@fs/schema";
import { countWords } from "@fs/core";
import { resolveUrl } from "./url.ts";

/** Minimal DOM surface we use, satisfied by linkedom's nodes. */
interface DomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}
interface DomElement extends DomNode {
  tagName: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  children: ArrayLike<DomElement>;
}

const ELEMENT = 1;
const TEXT = 3;

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Converts sanitized article HTML (Readability's output) into block JSON.
 * Only text, image URLs and table cells survive, so nothing executable can
 * reach the app.
 */
export function htmlToBlocks(root: DomElement, baseUrl: string): Block[] {
  const blocks: Block[] = [];
  let pendingText = "";

  const flushText = () => {
    const text = cleanText(pendingText);
    if (text) blocks.push({ type: "paragraph", text });
    pendingText = "";
  };

  const pushImage = (img: DomElement, caption?: string) => {
    const raw = img.getAttribute("src") ?? img.getAttribute("data-src") ?? firstSrcset(img.getAttribute("srcset"));
    const src = raw ? resolveUrl(raw, baseUrl) : null;
    if (!src) return;
    const alt = cleanText(img.getAttribute("alt"));
    blocks.push({ type: "image", src, ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) });
  };

  const visit = (node: DomNode) => {
    if (node.nodeType === TEXT) {
      pendingText += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const el = node as DomElement;
    const tag = el.tagName.toLowerCase();

    switch (tag) {
      case "script":
      case "style":
      case "noscript":
      case "iframe":
      case "form":
      case "button":
      case "svg":
        return;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        flushText();
        const text = cleanText(el.textContent);
        if (text) blocks.push({ type: "heading", level: Number(tag[1]), text });
        return;
      }
      case "p": {
        flushText();
        const text = cleanText(el.textContent);
        if (text) blocks.push({ type: "paragraph", text });
        else for (const img of Array.from(el.querySelectorAll("img"))) pushImage(img);
        return;
      }
      case "pre": {
        flushText();
        const text = (el.textContent ?? "").trim();
        if (text) blocks.push({ type: "paragraph", text });
        return;
      }
      case "blockquote": {
        flushText();
        const text = cleanText(el.textContent);
        if (text) blocks.push({ type: "quote", text });
        return;
      }
      case "ul":
      case "ol": {
        flushText();
        const items = Array.from(el.children)
          .filter((c) => c.tagName.toLowerCase() === "li")
          .map((li) => cleanText(li.textContent))
          .filter(Boolean);
        if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
        return;
      }
      case "figure": {
        flushText();
        const caption = cleanText(el.querySelector("figcaption")?.textContent);
        const imgs = Array.from(el.querySelectorAll("img"));
        if (imgs.length) imgs.forEach((img, i) => pushImage(img, i === imgs.length - 1 ? caption || undefined : undefined));
        else if (el.querySelector("table")) visit(el.querySelector("table")!);
        if (!imgs.length && caption) blocks.push({ type: "caption", text: caption });
        return;
      }
      case "img":
        flushText();
        pushImage(el);
        return;
      case "figcaption": {
        flushText();
        const text = cleanText(el.textContent);
        if (text) blocks.push({ type: "caption", text });
        return;
      }
      case "table": {
        flushText();
        const table = tableToBlock(el);
        if (table) blocks.push(table);
        return;
      }
      case "br":
        pendingText += " ";
        return;
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "footer":
      case "aside":
      case "details":
      case "dl":
        // Block containers: their loose text is its own paragraph.
        flushText();
        for (const child of Array.from(el.childNodes)) visit(child);
        flushText();
        return;
      default:
        // Inline elements (a, em, strong, span, code, …) contribute their text.
        for (const child of Array.from(el.childNodes)) visit(child);
    }
  };

  for (const child of Array.from(root.childNodes)) visit(child);
  flushText();
  return blocks;
}

function firstSrcset(srcset: string | null): string | null {
  return srcset?.split(",")[0]?.trim().split(/\s+/)[0] ?? null;
}

function tableToBlock(table: DomElement): Block | null {
  const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children)
      .filter((c) => ["td", "th"].includes(c.tagName.toLowerCase()))
      .map((c) => cleanText(c.textContent)),
  );
  const nonEmpty = rows.filter((r) => r.some(Boolean));
  if (!nonEmpty.length) return null;
  const firstRow = table.querySelector("tr");
  const firstIsHeader =
    !!firstRow &&
    Array.from(firstRow.children).length > 0 &&
    Array.from(firstRow.children).every((c) => c.tagName.toLowerCase() === "th");
  if (firstIsHeader) {
    const [header, ...rest] = nonEmpty;
    return { type: "table", header, rows: rest };
  }
  return { type: "table", rows: nonEmpty };
}

/** Sections longer than this (with no headings to split on) are cut at paragraph boundaries. */
const MAX_SECTION_WORDS = 600;

/**
 * Splits blocks into sections for the section rail and "Summarize section".
 * Headings of level 1–3 start a new section; long runs without headings are
 * chunked so a summary never covers a whole long essay.
 */
export function buildSections(blocks: readonly Block[]): Section[] {
  const sections: Section[] = [];
  let start = 0;
  let title: string | null = null;
  let words = 0;

  const close = (end: number) => {
    if (end > start) sections.push({ id: `s${sections.length + 1}`, title, startBlock: start, endBlock: end });
  };

  blocks.forEach((block, i) => {
    if (block.type === "heading" && block.level <= 3) {
      close(i);
      start = i;
      title = block.text;
      words = 0;
      return;
    }
    if (words >= MAX_SECTION_WORDS && block.type === "paragraph") {
      close(i);
      start = i;
      title = null;
      words = 0;
    }
    words += countWords(blockText(block));
  });
  close(blocks.length);
  return sections;
}

export function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
    case "caption":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "image":
      return block.caption ?? "";
    case "table":
      return [block.header ?? [], ...block.rows].map((r) => r.join(" | ")).join("\n");
  }
}

export function blocksToText(blocks: readonly Block[]): string {
  return blocks
    .map(blockText)
    .filter(Boolean)
    .join("\n\n");
}
