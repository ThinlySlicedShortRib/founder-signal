import { normalizeText, phraseMatches, stemSet } from "./text-match.ts";

/**
 * The letter's copy (build plan §6.5): what the writer is given, what it must
 * return, the deterministic checks every piece passes before it's sent, and
 * the fallback copy written from the piece's own words when no model is
 * available. Nothing here invents a claim.
 */

/** A retrieved passage the writer can cite. IDs are unique within a letter. */
export interface Passage {
  id: string;
  text: string;
}

export interface WriterBrief {
  role: string | null;
  lately: string | null;
  topics: string[];
  /** The previous letter's "Tomorrow, more of" choices. */
  leanings: string[];
  /** Imported facts the user kept, in their words. */
  facts: string[];
}

export interface WriterPiece {
  /** The item ID. */
  ref: string;
  kind: "article" | "video";
  title: string;
  sourceName: string;
  author: string | null;
  minutes: number;
  topic: string;
  passages: Passage[];
  /** The tags this piece may carry; the writer picks one or none. */
  allowedTags: string[];
  /** Why ranking picked it, e.g. `{ kind: "lately", detail: "how Costco makes money" }`. */
  signals: { kind: string; detail: string | null }[];
}

export interface WriterInput {
  brief: WriterBrief;
  /** The picks first, then reserve pieces copy is written for in the same call. */
  pieces: WriterPiece[];
  /** How many of `pieces` are the letter (the rest are reserve). */
  pickCount: number;
}

export interface PieceCopy {
  ref: string;
  whyPicked: string | null;
  summary: string;
  tag: string | null;
  evidenceIds: string[];
}

export interface LetterCopy {
  headline: string;
  intro: string;
  pieces: PieceCopy[];
}

export const COPY_LIMITS = { summary: 320, whyPicked: 220, headline: 80, intro: 160 } as const;

/**
 * Splits an item's text into passages for the writer: the opening, plus the
 * paragraphs that best match the user's brief, in reading order. Each is
 * capped, so a letter's input stays small.
 */
export function selectPassages(
  ref: string,
  paragraphs: string[],
  { focus = [], max = 6, maxChars = 700 }: { focus?: string[]; max?: number; maxChars?: number } = {},
): Passage[] {
  const clean = paragraphs.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.split(" ").length >= 6);
  if (!clean.length) return [];
  const scored = clean.map((text, i) => {
    const stems = stemSet(text);
    const hits = focus.filter((f) => phraseMatches(f, stems)).length;
    // The opening paragraphs usually carry the argument.
    return { i, text, score: hits * 2 + (i < 2 ? 1.5 - i * 0.5 : 0) + (/\d/.test(text) ? 0.3 : 0) };
  });
  const chosen = scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i);
  return chosen.map((c, n) => ({ id: `${ref.slice(0, 8)}.p${n + 1}`, text: clip(c.text, maxChars) }));
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${cut.slice(0, end > max / 2 ? end + (cut[end] === "." ? 1 : 0) : max)}…`;
}

// ── Deterministic checks (§6.5) ─────────────────────────────────────────────

/** Numbers as written: "33", "$5M", "1,200", "40%", "2.5x". Returns their digit cores ("5", "1200", "2.5"). */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const core = m[0].replace(/,(?=\d{3}\b)/g, "").replace(/,$/, "");
    if (core) out.push(core.replace(/\.0+$/, ""));
  }
  return out;
}

/** Text between quote marks, at least three characters long. */
export function quotesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of normalizeText(text).matchAll(/"([^"]{3,})"/g)) out.push(m[1]!.trim().replace(/[.,;:!?…]+$/, ""));
  return out;
}

function containsQuote(source: string, quote: string): boolean {
  const norm = (s: string) => normalizeText(s).replace(/[.,;:!?…"]/g, "").replace(/\s+/g, " ");
  return norm(source).includes(norm(quote));
}

/**
 * Checks one piece's copy against its own passages and the user's brief.
 * Returns the reasons it fails; empty means it passes.
 *
 * - every evidence ID exists and belongs to this piece, and the summary cites one;
 * - every number and quoted string in the summary appears in the cited passages;
 * - "why I picked this" may only quote the user's own words or the piece, and
 *   its numbers must appear in one of them;
 * - the tag is one the piece may carry; no links; lengths are bounded.
 */
export function checkPieceCopy(copy: PieceCopy, piece: Pick<WriterPiece, "passages" | "allowedTags" | "title">, briefText: string): string[] {
  const reasons: string[] = [];
  const byId = new Map(piece.passages.map((p) => [p.id, p.text]));
  const unknown = copy.evidenceIds.filter((id) => !byId.has(id));
  if (unknown.length) reasons.push(`unknown_evidence:${unknown.join(",")}`);
  const cited = copy.evidenceIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  if (!cited.length) reasons.push("no_evidence");

  const summary = copy.summary.trim();
  if (summary.length < 15) reasons.push("summary_too_short");
  if (summary.length > COPY_LIMITS.summary) reasons.push("summary_too_long");
  const citedText = [piece.title, ...cited].join("\n");
  const citedNumbers = new Set(numbersIn(citedText));
  for (const n of numbersIn(summary)) if (!citedNumbers.has(n)) reasons.push(`summary_number_unsupported:${n}`);
  for (const q of quotesIn(summary)) if (!containsQuote(citedText, q)) reasons.push("summary_quote_unsupported");

  if (copy.whyPicked !== null) {
    const why = copy.whyPicked.trim();
    if (why.length > COPY_LIMITS.whyPicked) reasons.push("why_too_long");
    const allSource = [briefText, piece.title, ...piece.passages.map((p) => p.text)].join("\n");
    const allNumbers = new Set(numbersIn(allSource));
    for (const n of numbersIn(why)) if (!allNumbers.has(n)) reasons.push(`why_number_unsupported:${n}`);
    for (const q of quotesIn(why)) if (!containsQuote(allSource, q)) reasons.push("why_quote_unsupported");
  }

  if (copy.tag !== null && !piece.allowedTags.includes(copy.tag)) reasons.push("tag_not_allowed");
  if (/https?:\/\/|www\./i.test(`${summary} ${copy.whyPicked ?? ""}`)) reasons.push("contains_link");
  return reasons;
}

/** The headline and intro may only use the letter's own numbers (piece count, minutes). */
export function checkLetterCopy(copy: Pick<LetterCopy, "headline" | "intro">, allowedNumbers: number[], briefText: string): string[] {
  const reasons: string[] = [];
  if (!copy.headline.trim() || copy.headline.length > COPY_LIMITS.headline) reasons.push("headline_length");
  if (!copy.intro.trim() || copy.intro.length > COPY_LIMITS.intro) reasons.push("intro_length");
  const allowed = new Set(allowedNumbers.map(String));
  for (const n of numbersIn(`${copy.headline} ${copy.intro}`)) if (!allowed.has(n)) reasons.push(`letter_number_unsupported:${n}`);
  for (const q of quotesIn(`${copy.headline} ${copy.intro}`)) if (!containsQuote(briefText, q)) reasons.push("letter_quote_unsupported");
  return reasons;
}

/** Everything the user told us, as one text, for checking quotes of their words. */
export function briefText(brief: WriterBrief): string {
  return [brief.role, brief.lately, ...brief.topics, ...brief.leanings, ...brief.facts].filter(Boolean).join("\n");
}

// ── Fallback copy: the piece's own words, no model ──────────────────────────

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The first one or two sentences of the first passage, verbatim. */
export function leadSentences(text: string, maxChars: number = COPY_LIMITS.summary - 20): string {
  const sentences = text.match(/[^.!?…]+[.!?…]+["”’)]*\s*/g) ?? [text];
  let out = "";
  for (const s of sentences.slice(0, 2)) {
    if ((out + s).trim().length > maxChars) break;
    out += s;
  }
  out = out.trim() || clip(text, maxChars);
  return out.length > maxChars ? clip(out, maxChars) : out;
}

/** "Why I picked this" from the strongest signal that has the user's own words or topic, else null. */
export function fallbackWhyPicked(signals: WriterPiece["signals"]): string | null {
  for (const s of signals) {
    if (!s.detail) continue;
    switch (s.kind) {
      case "lately":
        return `Because you said you're into “${s.detail}”.`;
      case "leaning":
        return `You asked for more of “${s.detail}”.`;
      case "topic":
        return `It's about ${s.detail.toLowerCase()}, one of your topics.`;
    }
  }
  if (signals.some((s) => s.kind === "source_mode" && s.detail === "follow_closely")) return "From a source you follow closely.";
  // The search's reason is model text from search results, not the user's words or the piece's, so it
  // isn't repeated here: a number in it would fail verification. It stays in the pick signals.
  if (signals.some((s) => s.kind === "discovered")) return "A new source, found by searching the web for what you're into.";
  return null;
}

export function fallbackPieceCopy(piece: WriterPiece): PieceCopy {
  const first = piece.passages[0];
  return {
    ref: piece.ref,
    whyPicked: fallbackWhyPicked(piece.signals),
    summary: first ? leadSentences(first.text) : piece.title,
    tag: piece.allowedTags[0] ?? null,
    evidenceIds: first ? [first.id] : [],
  };
}

/** "Pricing and hiring, for a founder". */
export function fallbackHeadline(topics: string[], role: string | null): string {
  const distinct = [...new Set(topics.map((t) => t.toLowerCase()))];
  const subject = distinct.length >= 2 ? `${distinct[0]} and ${distinct[1]}` : (distinct[0] ?? "a few good reads");
  const line = role ? `${subject}, for a ${role.toLowerCase()}` : `${subject}, picked for you`;
  return (line[0]!.toUpperCase() + line.slice(1)).slice(0, COPY_LIMITS.headline);
}

/** "Three things I picked for you. 33 minutes in all." */
export function fallbackIntro(count: number, totalMinutes: number): string {
  const n = NUMBER_WORDS[count] ?? String(count);
  const things = count === 1 ? "One thing I picked for you." : `${n} things I picked for you.`;
  return `${things} ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"} in all.`;
}

export function fallbackLetterCopy(input: WriterInput): LetterCopy {
  const picks = input.pieces.slice(0, input.pickCount);
  const total = picks.reduce((s, p) => s + p.minutes, 0);
  return {
    headline: fallbackHeadline(picks.map((p) => p.topic), input.brief.role),
    intro: fallbackIntro(picks.length, total),
    pieces: input.pieces.map(fallbackPieceCopy),
  };
}
