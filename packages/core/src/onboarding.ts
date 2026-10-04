import type { FactFills, NamedSource, ProfileFact, ProfileFactKind, ReadingPlatform, Role, SensitiveCategory, Topic } from "@fs/schema";

/**
 * Onboarding rules with no I/O: which topics a phrase points to, what counts
 * as too personal to keep from an imported profile, a plain parser for the
 * note the import prompt asks an assistant to write, and how kept facts fill
 * the onboarding form. The API prefers a model for reading the note; this
 * parser is its fallback, and `screenFacts` checks the model's work.
 */

/** A reading of a pasted note, before the API gives it an import ID. */
export interface ParsedNote {
  facts: ProfileFact[];
  dropped: { category: SensitiveCategory }[];
}

export const NO_FILLS: FactFills = Object.freeze({ role: null, lately: null, topics: [], platforms: [], sources: [] }) as FactFills;

const TOPIC_SIGNALS: [RegExp, Topic[]][] = [
  [/business model|makes (its )?money|membership|subscription|margin|unit economics/i, ["business models", "pricing"]],
  [/pric(e|ing)|tiers?\b|usage-based|willingness to pay/i, ["pricing"]],
  [/open.?source|github|\brepos?\b|maintainer/i, ["open source", "developer tools"]],
  [/developer tools?|dev ?tools|\bapi\b|\bsdk\b|\bide\b/i, ["developer tools"]],
  [/customer|first (ten|10)|design partner|pilot/i, ["first customers"]],
  [/\bsales\b|selling|cold (email|outreach)|outbound|pipeline/i, ["sales"]],
  [/hir(e|ing)|recruit|first engineer|team building/i, ["hiring"]],
  [/rais(e|ing)|investors?|\bfund(ing|raise|raising)?\b|\bvc\b|seed round|series [ab]/i, ["fundraising"]],
  [/\bai\b|agents?\b|\bllms?\b|machine learning|\bgpt\b|claude|gemini/i, ["AI tools"]],
  [/distribution|growth|audience|\bseo\b|marketing|launch|go-to-market|\bgtm\b/i, ["distribution"]],
];

/** Topics a free-text phrase points to, in the order they're first matched. */
export function topicsFromText(text: string): Topic[] {
  const found: Topic[] = [];
  for (const [pattern, ts] of TOPIC_SIGNALS) {
    if (!pattern.test(text)) continue;
    for (const t of ts) if (!found.includes(t)) found.push(t);
  }
  return found;
}

const ROLE_SIGNALS: [RegExp, Role][] = [
  [/\b(investor|venture capital|\bvc\b|angel)\b/i, "investor"],
  [/\b(co-?)?founder\b|\bceo\b|my (own )?(startup|company)/i, "founder"],
  [/\bconsult(ant|ing)\b|\bfreelanc|\bagency\b/i, "consultant"],
  [/\b(want|plan|hope|thinking about) to (start|found|build)|aspiring founder|founder-to-be/i, "founder-to-be"],
  [/\b(operator|head of|vp |product manager|\bpm\b|engineer|chief of staff|growth lead)/i, "startup operator"],
];

export function roleFromText(text: string): Role | null {
  // "Founder-to-be" mentions "founder" too, so it's checked before the plain founder rule.
  if (ROLE_SIGNALS[3]![0].test(text)) return "founder-to-be";
  for (const [pattern, role] of ROLE_SIGNALS) if (pattern.test(text)) return role;
  return null;
}

/** What the import prompt tells the assistant to leave out; checked again on our side. */
const SENSITIVE: [RegExp, SensitiveCategory][] = [
  [/\b(password|passcode|api[ -]?key|secret key|(access|auth|api) token|2fa|ssh key|login details|credentials?)\b/i, "credentials"],
  // Personal phrasings only: "health" or "clinic" alone is often what someone's company does.
  [/\b(injur(y|ies|ed)|illness|diagnos(is|ed)|medication|surgery|pregnan|anxiety|depression|adhd|back pain|my (health|doctor|therapist|therapy)|health (issue|condition|problem|scare)s?)\b/i, "health"],
  [/\b(salary|personal debt|mortgage|student loans?|my savings|net worth|bank account|credit card|my taxes|my income|my rent|bankrupt)/i, "finances"],
  [/\b(wife|husband|partner's|girlfriend|boyfriend|divorce|marriage|my (kids?|children|son|daughter|mom|mum|dad|mother|father|sister|brother|family)|dating)\b/i, "family"],
  [/\b(confidential|under nda|\bnda\b|internal only|not public|my (employer|client)'s)/i, "confidential"],
];

export function sensitiveCategory(text: string): SensitiveCategory | null {
  for (const [pattern, category] of SENSITIVE) if (pattern.test(text)) return category;
  return null;
}

const HEADINGS: [RegExp, ProfileFactKind][] = [
  [/^work\b/i, "work"],
  [/^building( now)?\b/i, "building"],
  [/^curious( about)?\b/i, "curious"],
  [/^recurring( questions)?\b|^keeps? asking\b/i, "recurring"],
  [/^sources?\b/i, "source"],
];

/** Sentences the assistant writes when it has nothing to go on. */
const NOTHING_KNOWN = /\b(don't|do not|doesn't) (know|have) (much|enough|any)|no (information|memory|prior conversations)/i;

const MAX_FACTS = 12;

/**
 * Reads the note the import prompt asks for ("1. Work: …", "2. Building now: …").
 * Lines that look personal are dropped and only their category is reported.
 */
export function parseProfileNote(text: string): ParsedNote {
  const facts: ProfileFact[] = [];
  const dropped: { category: SensitiveCategory }[] = [];
  let kind: ProfileFactKind | null = null;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").replace(/\*\*/g, "").trim();
    if (!line) continue;

    const heading = /^([^:]{2,30}):\s*(.*)$/.exec(line);
    if (heading) {
      const match = HEADINGS.find(([re]) => re.test(heading[1]!.trim()));
      if (match) {
        kind = match[1];
        line = heading[2]!.trim();
        if (!line) continue;
      }
    }
    if (NOTHING_KNOWN.test(line)) continue;

    // An aside in brackets is usually something the assistant noticed in passing.
    for (const part of splitAsides(line)) {
      const category = sensitiveCategory(part);
      if (category) {
        dropped.push({ category });
        continue;
      }
      if (!kind || part.length < 3) continue;
      // Lists of several things under one heading become one fact per item.
      const items = kind === "work" ? [part] : part.split(/;\s*/);
      for (const item of items) {
        const clean = item.replace(/[.;,]+$/, "").trim();
        if (clean.length < 3) continue;
        facts.push({ kind, text: clean.slice(0, 300), fills: fillsFor(kind, clean) });
      }
    }
  }

  return { facts: facts.slice(0, MAX_FACTS), dropped };
}

const PLATFORM_SIGNALS: [RegExp, ReadingPlatform][] = [
  [/substack/i, "substack"],
  [/youtube/i, "youtube"],
  [/\btwitter\b|\bon x\b|\bx\.com\b/i, "x"],
];

/** What a line of the note fills in the form, by its heading. */
export function fillsFor(kind: ProfileFactKind, text: string): FactFills {
  const topics = topicsFromText(text);
  switch (kind) {
    case "work":
      return { ...NO_FILLS, role: roleFromText(text), topics };
    case "building":
      return { ...NO_FILLS, lately: text, topics };
    case "curious":
    case "recurring":
      return { ...NO_FILLS, topics };
    case "source": {
      const sources: NamedSource[] = text
        .split(/,\s*|\s+and\s+/)
        .map((n) => n.trim())
        .filter((n) => n.length > 1)
        .map((name) => ({ name: name.slice(0, 120), url: /^https?:\/\//.test(name) ? name : null }));
      const platforms = PLATFORM_SIGNALS.filter(([re]) => re.test(text)).map(([, p]) => p);
      return { ...NO_FILLS, sources, platforms };
    }
  }
}

export interface FilledForm {
  role: string | null;
  lately: string | null;
  topics: string[];
  platforms: ReadingPlatform[];
  sources: NamedSource[];
}

/**
 * The onboarding form as the kept facts fill it: the first role and "lately"
 * win, topics, platforms and sources are merged without repeats.
 */
export function formFromFacts(facts: ProfileFact[]): FilledForm {
  const form: FilledForm = { role: null, lately: null, topics: [], platforms: [], sources: [] };
  const seen = (xs: string[], x: string) => xs.some((y) => y.toLowerCase() === x.toLowerCase());
  for (const fact of facts) {
    // Facts saved before they carried fills (or sent by an older app) fill nothing.
    const fills = fact?.fills ?? NO_FILLS;
    form.role ??= fills.role;
    form.lately ??= fills.lately;
    for (const t of fills.topics) if (!seen(form.topics, t)) form.topics.push(t);
    for (const p of fills.platforms) if (!form.platforms.includes(p)) form.platforms.push(p);
    for (const s of fills.sources) if (!seen(form.sources.map((x) => x.name), s.name)) form.sources.push(s);
  }
  return form;
}

function splitAsides(line: string): string[] {
  const asides = [...line.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!.trim());
  const main = line.replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return [main, ...asides].filter(Boolean);
}

/**
 * Final check on facts that came back from a model (or from the client):
 * anything that still looks personal, in the line or in what it fills, is
 * dropped, and topics are filled in where none were given.
 */
export function screenFacts(facts: ProfileFact[]): ParsedNote {
  const kept: ProfileFact[] = [];
  const dropped: { category: SensitiveCategory }[] = [];
  for (const fact of facts) {
    const fills = fact.fills ?? NO_FILLS;
    const category = [fact.text, fills.role, fills.lately, ...fills.topics].map((t) => (t ? sensitiveCategory(t) : null)).find(Boolean);
    if (category) dropped.push({ category });
    else kept.push({ ...fact, fills: { ...fills, topics: fills.topics.length ? fills.topics : fact.kind === "source" ? [] : topicsFromText(fact.text) } });
  }
  return { facts: kept.slice(0, MAX_FACTS), dropped };
}

/**
 * A line from the piece itself for a pick card's pull quote: the first whole
 * sentence of a readable length, or null. Never generated, only selected.
 */
export function quoteFrom(text: string | null | undefined, { min = 40, max = 160 } = {}): string | null {
  if (!text) return null;
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["”’)]?/g) ?? [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (s.length >= min && s.length <= max && /^[\p{Lu}"“‘(]/u.test(s)) return s;
  }
  return null;
}
