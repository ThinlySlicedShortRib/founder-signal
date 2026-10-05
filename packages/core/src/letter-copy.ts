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
  /** The P.S.: one short paragraph recapping the letter's pieces together, until the user gives feedback. */
  postscript: string;
  pieces: PieceCopy[];
}

export const COPY_LIMITS = { summary: 320, whyPicked: 220, headline: 80, intro: 200, postscript: 480 } as const;
/** The P.S. is asked for in about 60 words; this is the hard cap, with room for long titles. */
export const POSTSCRIPT_MAX_WORDS = 80;

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

/**
 * The headline and the cover intro. The headline may only use the letter's own
 * numbers (piece count, minutes) and quote the user. The intro is a personal
 * hook, so it may also use a number from one of the picks' titles or passages
 * (a concrete figure is often the best reason to start reading), and quote the
 * user or name a pick by its title; no exclamation marks outside a title, no links.
 */
export function checkLetterCopy(
  copy: Pick<LetterCopy, "headline" | "intro">,
  allowedNumbers: number[],
  briefText: string,
  picks: Pick<WriterPiece, "title" | "passages">[] = [],
): string[] {
  const reasons: string[] = [];
  if (!copy.headline.trim() || copy.headline.length > COPY_LIMITS.headline) reasons.push("headline_length");
  const allowed = new Set(allowedNumbers.map(String));
  for (const n of numbersIn(copy.headline)) if (!allowed.has(n)) reasons.push(`letter_number_unsupported:${n}`);
  for (const q of quotesIn(copy.headline)) if (!containsQuote(briefText, q)) reasons.push("letter_quote_unsupported");

  const intro = copy.intro.trim();
  if (!intro || intro.length > COPY_LIMITS.intro) reasons.push("intro_length");
  const pickText = picks.flatMap((p) => [p.title, ...p.passages.map((x) => x.text)]).join("\n");
  const introNumbers = new Set([...allowed, ...numbersIn(pickText)]);
  for (const n of numbersIn(intro)) if (!introNumbers.has(n)) reasons.push(`intro_number_unsupported:${n}`);
  for (const q of quotesIn(intro)) if (!containsQuote(briefText, q) && !picks.some((p) => containsQuote(p.title, q))) reasons.push("intro_quote_unsupported");
  if (normalizeText(intro).replace(/"[^"]*"/g, "").includes("!")) reasons.push("intro_exclamation");
  if (/https?:\/\/|www\./i.test(intro)) reasons.push("contains_link");
  return reasons;
}

/**
 * Checks a P.S. recap against the letter's pieces: within the length cap, no
 * exclamation marks or links, every quoted string is one of the pieces'
 * titles (so it names only this letter's pieces), and every number appears in
 * a title or summary. With `requireEach`, every piece must be named.
 */
export function checkPostscript(text: string, pieces: { title: string; summary: string }[], { requireEach = true }: { requireEach?: boolean } = {}): string[] {
  const reasons: string[] = [];
  const t = text.trim();
  if (!t || t.length > COPY_LIMITS.postscript || t.split(/\s+/).length > POSTSCRIPT_MAX_WORDS) reasons.push("postscript_length");
  // A title may have its own "!"; the words around it may not.
  if (normalizeText(t).replace(/"[^"]*"/g, "").includes("!")) reasons.push("postscript_exclamation");
  if (/https?:\/\/|www\./i.test(t)) reasons.push("contains_link");
  const quotes = quotesIn(t);
  if (quotes.some((q) => !pieces.some((p) => containsQuote(p.title, q)))) reasons.push("postscript_names_other_piece");
  if (requireEach && pieces.some((p) => !quotes.some((q) => containsQuote(p.title, q)))) reasons.push("postscript_missing_piece");
  const known = new Set(numbersIn(pieces.map((p) => `${p.title}\n${p.summary}`).join("\n")));
  for (const n of numbersIn(t)) if (!known.has(n)) reasons.push(`postscript_number_unsupported:${n}`);
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

/** "Three things I picked for you. 33 minutes in all." The last resort when nothing personal fits. */
export function countIntro(count: number, totalMinutes: number): string {
  const n = NUMBER_WORDS[count] ?? String(count);
  const things = count === 1 ? "One thing I picked for you." : `${n} things I picked for you.`;
  return `${things} ${minutesInAll(totalMinutes)}`;
}

function minutesInAll(totalMinutes: number): string {
  return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"} in all.`;
}

/** "Moving upmarket" → "moving upmarket", but "SEO" and "AI evals" stay. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}

/**
 * The cover intro without a model: a hook from the user's own words, then where
 * to start and what follows, then the minutes. "You said you're into “getting
 * off hourly billing”: start with “Price the outcome”, then two more on pricing
 * and hiring. 18 minutes in all." It leads with the pick tied to what they're
 * into lately or a "Tomorrow, more of" choice, else the first; with neither, their role.
 * Falls back to shorter forms, and finally the count, to stay within the cap.
 */
export function fallbackIntro(brief: WriterBrief, picks: Pick<WriterPiece, "title" | "topic" | "minutes" | "signals">[]): string {
  const total = picks.reduce((s, p) => s + p.minutes, 0);
  if (!picks.length) return countIntro(0, total);
  const tied = (kind: string) => picks.findIndex((p) => p.signals.some((s) => s.kind === kind && s.detail));
  const latelyAt = brief.lately ? tied("lately") : -1;
  const leadIndex = latelyAt >= 0 ? latelyAt : Math.max(0, tied("leaning"));
  const lead = picks[leadIndex]!;
  const rest = picks.filter((_, i) => i !== leadIndex);
  const leaning = lead.signals.find((s) => s.kind === "leaning" && s.detail && brief.leanings.some((l) => normalizeText(l) === normalizeText(s.detail!)));

  const hooks: string[] = [];
  if (brief.lately && lead.signals.some((s) => s.kind === "lately")) hooks.push(`You said you're into “${lowerFirst(brief.lately.replace(/["“”]/g, "").trim().replace(/[.!?]+$/, ""))}”`);
  else if (leaning) hooks.push(`You asked for “${lowerFirst(leaning.detail!)}”`);
  if (brief.role) hooks.push(`For ${/^[aeiou]/i.test(brief.role) ? "an" : "a"} ${lowerFirst(brief.role.trim())}`);
  hooks.push("");

  const title = `“${lead.title}”`;
  const topics = [...new Set(rest.map((p) => lowerFirst(p.topic)))];
  const more = NUMBER_WORDS[rest.length]?.toLowerCase() ?? String(rest.length);
  const mains = !rest.length
    ? [`just one today, ${title}${/[.?!…]$/.test(lead.title) ? "" : "."}`]
    : [
        ...(topics.length <= 2 ? [`start with ${title}, then ${more} more on ${andList(topics)}.`] : []),
        `start with ${title}, then ${more} more.`,
      ];

  for (const hook of hooks) {
    for (const main of mains) {
      const line = hook ? `${hook}: ${main} ${minutesInAll(total)}` : `${main[0]!.toUpperCase()}${main.slice(1)} ${minutesInAll(total)}`;
      if (line.length <= COPY_LIMITS.intro) return line;
    }
  }
  return countIntro(picks.length, total);
}

/** "Today was “A”, “B” and “C”. Tell me which were worth your time." The P.S. without a model; null without pieces. */
export function fallbackPostscript(titles: string[]): string | null {
  if (!titles.length) return null;
  const named = titles.map((t) => `“${t}”`);
  const list = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)!}`;
  return `Today was ${list}. ${titles.length === 1 ? "Tell me if it was worth your time." : "Tell me which were worth your time."}`;
}

export function fallbackLetterCopy(input: WriterInput): LetterCopy {
  const picks = input.pieces.slice(0, input.pickCount);
  return {
    headline: fallbackHeadline(picks.map((p) => p.topic), input.brief.role),
    intro: fallbackIntro(input.brief, picks),
    postscript: fallbackPostscript(picks.map((p) => p.title)) ?? "",
    pieces: input.pieces.map(fallbackPieceCopy),
  };
}
