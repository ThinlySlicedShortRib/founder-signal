import type { Block } from "@fs/schema";
import { containsQuote, numbersIn, quotesIn } from "./letter-copy.ts";
import { countWords } from "./reading.ts";

/**
 * A piece as a short podcast episode (experiment): the episode script's
 * shape, the deterministic checks it passes before it's voiced (in the
 * spirit of the letter's §6.5 checks: every number and quote must come from
 * the piece), the no-model fallback (the piece's own opening, read aloud),
 * and the pure parts of voicing: text made speakable, split into chunks the
 * TTS model takes, stitched on a timeline with chapter marks, and costed.
 */

/** `conversation`: two hosts talk the piece through. `narration`: one voice summarizes it. `reading`: the piece's own words (the fallback). */
export const episodeFormats = ["conversation", "narration", "reading"] as const;
export type EpisodeFormat = (typeof episodeFormats)[number];

/** `host` leads; `cohost` asks and reacts (conversation only). */
export const episodeSpeakers = ["host", "cohost"] as const;
export type EpisodeSpeaker = (typeof episodeSpeakers)[number];

export interface EpisodeLine {
  speaker: EpisodeSpeaker;
  text: string;
}

export interface EpisodeChapter {
  title: string;
  lines: EpisodeLine[];
}

export interface EpisodeScript {
  format: EpisodeFormat;
  chapters: EpisodeChapter[];
}

/** A chapter mark in the finished audio. */
export interface ChapterMark {
  title: string;
  startSeconds: number;
}

export const EPISODE_LIMITS = {
  /** Spoken words: about 2–9 minutes at ~165 words a minute. */
  minWords: 300,
  maxWords: 1500,
  maxChapters: 8,
  maxLineChars: 700,
  chapterTitle: 60,
  /** Article text given to the script writer (about 12k tokens). */
  sourceChars: 48_000,
} as const;

/** Typical conversational speaking rate, for estimates. */
export const WORDS_PER_MINUTE = 165;

// ── The article as text ─────────────────────────────────────────────────────

/**
 * The paragraphs an episode is made from: headings, paragraphs, quotes and
 * list items, in order. Images, captions and tables don't read aloud.
 */
export function episodeParagraphs(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
      case "paragraph":
      case "quote":
        if (b.text.trim()) out.push(b.text.replace(/\s+/g, " ").trim());
        break;
      case "list":
        for (const item of b.items) if (item.trim()) out.push(item.replace(/\s+/g, " ").trim());
        break;
    }
  }
  return out;
}

/** The article text the script writer sees, cut at a paragraph once it's long enough. */
export function episodeSourceText(paragraphs: readonly string[], maxChars: number = EPISODE_LIMITS.sourceChars): { text: string; truncated: boolean } {
  let text = "";
  for (const p of paragraphs) {
    if (text.length + p.length + 2 > maxChars) return { text: text.trim(), truncated: true };
    text += `${p}\n\n`;
  }
  return { text: text.trim(), truncated: false };
}

// ── Checks ───────────────────────────────────────────────────────────────────

const SPELLED_NUMBER = /\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i;
const SPEAKER_LABEL = /^\s*(host|cohost|co-host|speaker\s*\w*|narrator)\s*:/i;
const STAGE_DIRECTION = /\[[^\]]*\]|\*[^*]+\*/;

export function scriptWords(script: EpisodeScript): number {
  return script.chapters.reduce((n, c) => n + c.lines.reduce((m, l) => m + countWords(l.text), 0), 0);
}

/**
 * Checks a written script against the piece it's about. Returns the reasons
 * it fails; empty means it can be voiced.
 *
 * - every number (as digits) and every quoted string is in the piece or its title;
 * - numbers above ten are written as digits, so the check above sees them;
 * - no links, no speaker labels or stage directions in the spoken text;
 * - the right speakers for the format; bounded chapters, lines and length.
 */
export function checkEpisodeScript(script: EpisodeScript, source: { title: string; text: string }): string[] {
  const reasons: string[] = [];
  const lines = script.chapters.flatMap((c) => c.lines);
  if (!script.chapters.length || script.chapters.some((c) => !c.lines.length)) reasons.push("empty_chapter");
  if (script.chapters.length > EPISODE_LIMITS.maxChapters) reasons.push("too_many_chapters");
  if (script.chapters.some((c) => !c.title.trim() || c.title.length > EPISODE_LIMITS.chapterTitle)) reasons.push("chapter_title_length");

  const words = scriptWords(script);
  if (words < EPISODE_LIMITS.minWords) reasons.push(`too_short:${words}`);
  if (words > EPISODE_LIMITS.maxWords) reasons.push(`too_long:${words}`);

  const speakers = new Set(lines.map((l) => l.speaker));
  if (script.format === "conversation" && speakers.size < 2) reasons.push("one_speaker");
  if (script.format !== "conversation" && speakers.has("cohost")) reasons.push("unexpected_cohost");

  const sourceAll = `${source.title}\n${source.text}`;
  const have = new Set(numbersIn(sourceAll));
  const unsupported = new Set<string>();
  for (const l of lines) {
    const text = l.text.trim();
    if (!text) reasons.push("empty_line");
    if (text.length > EPISODE_LIMITS.maxLineChars) reasons.push("line_too_long");
    for (const n of numbersIn(text)) if (!have.has(n)) unsupported.add(n);
    for (const q of quotesIn(text)) if (!containsQuote(sourceAll, q)) reasons.push("quote_unsupported");
    if (SPELLED_NUMBER.test(text)) reasons.push("spelled_number");
    if (/https?:\/\/|www\./i.test(text)) reasons.push("contains_link");
    if (SPEAKER_LABEL.test(text) || STAGE_DIRECTION.test(text)) reasons.push("not_speech");
  }
  for (const n of unsupported) reasons.push(`number_unsupported:${n}`);
  return [...new Set(reasons)];
}

// ── Fallback: the piece's own words ─────────────────────────────────────────

/**
 * No model, or a script that kept failing its checks: one voice reads the
 * piece's opening paragraphs verbatim, up to about `maxWords`, with a line
 * that says where it came from. Nothing is invented by construction.
 */
export function readingScript(
  { title, sourceName, author }: { title: string; sourceName: string; author: string | null },
  paragraphs: readonly string[],
  maxWords: number = EPISODE_LIMITS.maxWords - 100,
): EpisodeScript {
  const by = author ? ` by ${author}` : "";
  const lines: EpisodeLine[] = [{ speaker: "host", text: `${title}${by}, from ${sourceName}.` }];
  let words = 0;
  let cut = false;
  for (const p of paragraphs) {
    const n = countWords(p);
    if (words + n > maxWords && words > 0) {
      cut = true;
      break;
    }
    lines.push({ speaker: "host", text: p });
    words += n;
  }
  lines.push({ speaker: "host", text: cut ? "That's the opening. The rest of the piece is in the app." : "That's the piece." });
  return { format: "reading", chapters: [{ title: "The piece", lines }] };
}

// ── Voices ───────────────────────────────────────────────────────────────────

/**
 * The voices per engine. Kokoro: its best-rated American female and male
 * voices. Polly (neural, available in ap-southeast-2): Olivia (en-AU) leads,
 * Matthew (en-US) answers.
 */
export const EPISODE_VOICES = {
  kokoro: { model: "kokoro-v1.0", host: "af_heart", cohost: "am_michael" },
  polly: { model: "polly-neural", host: "Olivia", cohost: "Matthew" },
} as const;
export type TtsEngine = keyof typeof EPISODE_VOICES;

/** Part of an episode's identity: `kokoro-v1.0:af_heart+am_michael`, or just the host for one voice. */
export function episodeVoiceKey(engine: TtsEngine, format: Exclude<EpisodeFormat, "reading">): string {
  const v = EPISODE_VOICES[engine];
  return `${v.model}:${format === "conversation" ? `${v.host}+${v.cohost}` : v.host}`;
}

// ── Speech ───────────────────────────────────────────────────────────────────

const MONEY_SCALE: Record<string, string> = { k: "thousand", m: "million", mm: "million", b: "billion", bn: "billion", t: "trillion" };

/**
 * Text as a TTS model should read it: plain quotes and dashes, money and
 * percentages spelled out the way a person says them ("$1.5M" → "1.5 million
 * dollars"), common abbreviations expanded, and anything that isn't speech
 * (links, markdown, bracketed directions) dropped. Plain numbers stay as
 * digits; the phonemizer reads those well.
 */
export function speakable(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(?:https?:\/\/|www\.)[^\s)]+/gi, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[*_#`]+/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\$(\d[\d,]*(?:\.\d+)?)\s*(bn|mm|[kmbt])\b/gi, (_, n: string, s: string) => `${n} ${MONEY_SCALE[s.toLowerCase()]} dollars`)
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, (_, n: string) => `${n} dollars`)
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d)x\b/g, "$1 times")
    .replace(/\be\.g\.,?/gi, "for example")
    .replace(/\bi\.e\.,?/gi, "that is")
    .replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/\betc\./gi, "and so on")
    .replace(/~\s*(?=\d)/g, "about ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+([,.!?;:)])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a line into chunks of at most `maxChars` for the TTS model (Kokoro
 * reads at most ~510 phonemes at once): whole sentences where they fit,
 * then clauses, then words.
 */
export function splitForSpeech(text: string, maxChars = 320): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) pieces.push(s);
    else pieces.push(...splitLong(s, maxChars));
  }
  // Join short neighbours so each chunk has enough context for natural prosody.
  const chunks: string[] = [];
  for (const p of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + p.length <= maxChars) chunks[chunks.length - 1] = `${last} ${p}`;
    else chunks.push(p);
  }
  return chunks;
}

function splitLong(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of sentence.split(/(?<=[,;:])\s+/)) {
    const words = part.length > maxChars ? part.split(/\s+/) : [part];
    for (const w of words) {
      if (current && current.length + 1 + w.length > maxChars) {
        out.push(current);
        current = w;
      } else current = current ? `${current} ${w}` : w;
    }
  }
  if (current) out.push(current);
  return out;
}

// ── Stitching ────────────────────────────────────────────────────────────────

/** One synthesized clip, in script order. */
export interface ClipInfo {
  chapter: number;
  line: number;
  speaker: EpisodeSpeaker;
  samples: number;
}

/** Silence between clips, in seconds. */
export const GAPS = {
  lead: 0.35,
  /** Between chunks of one line. */
  sameLine: 0.12,
  /** The same speaker carrying on in a new line (a paragraph break). */
  sameSpeaker: 0.45,
  /** The other host answering. */
  turn: 0.3,
  chapter: 0.9,
  tail: 0.8,
} as const;

export interface StitchPlan {
  /** Where each clip starts, in samples, by clip index. */
  offsets: number[];
  totalSamples: number;
  chapters: ChapterMark[];
}

/** Lays clips on one timeline with natural pauses, and marks where each chapter starts. */
export function stitchPlan(clips: readonly ClipInfo[], chapterTitles: readonly string[], sampleRate: number, gaps = GAPS): StitchPlan {
  const s = (seconds: number) => Math.round(seconds * sampleRate);
  const offsets: number[] = [];
  const chapters: ChapterMark[] = [];
  let at = s(gaps.lead);
  clips.forEach((clip, i) => {
    const prev = clips[i - 1];
    if (prev) {
      at +=
        clip.chapter !== prev.chapter
          ? s(gaps.chapter)
          : clip.line === prev.line
            ? s(gaps.sameLine)
            : clip.speaker === prev.speaker
              ? s(gaps.sameSpeaker)
              : s(gaps.turn);
    }
    if (!prev || clip.chapter !== prev.chapter) {
      // The first chapter starts at 0, so players show it from the beginning.
      chapters.push({ title: chapterTitles[clip.chapter] ?? `Part ${clip.chapter + 1}`, startSeconds: prev ? round2(at / sampleRate) : 0 });
    }
    offsets.push(at);
    at += clip.samples;
  });
  return { offsets, totalSamples: at + (clips.length ? s(gaps.tail) : 0), chapters };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Estimates ────────────────────────────────────────────────────────────────

export function estimateSpeechSeconds(words: number, wpm: number = WORDS_PER_MINUTE): number {
  return Math.round((words / wpm) * 60);
}

/** USD per million tokens (claude.com/pricing, October 2026). */
export const SCRIPT_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** USD per million characters (aws.amazon.com/polly/pricing, October 2026). Local models cost nothing per episode. */
export const TTS_PRICES: Record<string, number> = {
  kokoro: 0,
  "polly-standard": 4,
  "polly-neural": 16,
  "polly-generative": 30,
};

export interface EpisodeCost {
  scriptUsd: number;
  ttsUsd: number;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  characters: number;
}

/**
 * What an episode costs (or would cost on the API). Token counts are the
 * API's usage when known, else ~4 characters a token. A Claude Code CLI run
 * is priced as the API model it stands in for, so local runs show what AWS
 * would pay. Unknown models and engines count as free, so the estimate
 * never blocks generation.
 */
export function estimateEpisodeCost({
  model,
  inputTokens,
  outputTokens,
  promptChars = 0,
  outputChars = 0,
  ttsPriceKey,
  characters,
}: {
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  promptChars?: number;
  outputChars?: number;
  ttsPriceKey: string;
  characters: number;
}): EpisodeCost {
  const inTok = inputTokens ?? Math.ceil(promptChars / 4);
  const outTok = outputTokens ?? Math.ceil(outputChars / 4);
  const price = model ? SCRIPT_PRICES[apiModelOf(model)] : undefined;
  const scriptUsd = price ? (inTok * price.input + outTok * price.output) / 1e6 : 0;
  const ttsUsd = ((TTS_PRICES[ttsPriceKey] ?? 0) * characters) / 1e6;
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return { scriptUsd: r(scriptUsd), ttsUsd: r(ttsUsd), totalUsd: r(scriptUsd + ttsUsd), inputTokens: inTok, outputTokens: outTok, characters };
}

/** "claude-cli:sonnet" → "claude-sonnet-5-5": the API model a CLI alias stands in for. */
export function apiModelOf(model: string): string {
  const alias = model.startsWith("claude-cli:") ? model.slice("claude-cli:".length) : model;
  if (alias === "sonnet") return "claude-sonnet-5-5";
  if (alias === "haiku") return "claude-haiku-4-5";
  if (alias === "opus") return "claude-opus-5-5";
  return alias;
}
