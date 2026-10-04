import type { ReviewVote } from "@fs/schema";
import { displayTopic } from "./text-match.ts";

/**
 * The letter's P.S. (Layout 6): "Tomorrow, more of" options, the recap of
 * what the user marked worth it, and the "why this mix" line that names a
 * change after reasoned feedback (§6.4).
 */

export const LEANING_MAX_CHARS = 40;
export const LEANING_COUNT = 4;

export interface LeaningFeedback {
  vote: ReviewVote;
  reasons: string[];
  /** The piece's topic in the letter it came from. */
  topic: string | null;
}

const LIKE_LEANINGS: Record<string, string> = {
  numbers: "Pieces with real numbers",
  practical: "Practical how-tos",
  concise: "Short reads",
  depth: "Deeper dives",
  video: "More videos",
  fresh_take: "Fresh takes",
};
const DISLIKE_LEANINGS: Record<string, string> = { too_long: "Short reads", too_basic: "Deeper dives" };

/**
 * About four short options, from the user's recent feedback first, then their
 * topics, always ending with "Something new". Deterministic, each ≤ 40 chars.
 */
export function leaningOptions({
  topics,
  feedback,
  letterTopics,
}: {
  /** The user's topics, most important first. */
  topics: string[];
  /** Recent reviews, newest first. */
  feedback: LeaningFeedback[];
  /** Topics in the letter being locked. */
  letterTopics: string[];
}): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && t.length <= LEANING_MAX_CHARS && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  const room = () => out.length < LEANING_COUNT - 1;

  for (const f of feedback) {
    if (!room()) break;
    if (f.vote === "interested" && f.topic) {
      push(f.reasons.includes("numbers") ? `${displayTopic(f.topic)}, with numbers` : `More on ${f.topic.toLowerCase()}`);
    }
    for (const r of f.reasons) {
      if (!room()) break;
      const option = f.vote === "interested" ? LIKE_LEANINGS[r] : DISLIKE_LEANINGS[r];
      if (option) push(option);
    }
  }
  const covered = new Set(letterTopics.map((t) => t.toLowerCase()));
  for (const t of [...topics.filter((t) => !covered.has(t.toLowerCase())), ...topics]) {
    if (!room()) break;
    push(`More on ${t.toLowerCase()}`);
  }
  if (out.length < LEANING_COUNT - 1) push("Short reads");
  push("Something new");
  return out.slice(0, LEANING_COUNT);
}

export interface Verdict {
  itemId: string;
  vote: ReviewVote;
  reasons: string[];
}

/**
 * Changes whenever a verdict (either way) or its reasons on the letter's
 * pieces change, so the recap is rewritten lazily. Pieces without a verdict
 * aren't part of it, and no feedback signs as "".
 */
export function verdictSignature(verdicts: Verdict[]): string {
  return [...verdicts]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : 1))
    .map((v) => `${v.itemId}:${v.vote}:${[...v.reasons].sort().join("+")}`)
    .join("|");
}

const REASON_PHRASES: Record<string, string> = {
  topic: "the topic",
  creator: "who wrote it",
  practical: "how practical it was",
  numbers: "the numbers",
  depth: "the depth",
  concise: "how short it was",
  fresh_take: "the fresh take",
  video: "the video",
};

const DISLIKE_PHRASES: Record<string, string> = {
  not_my_topic: "not your topic",
  too_basic: "too basic",
  too_long: "too long",
  already_knew: "nothing new to you",
  not_credible: "not credible",
  too_promotional: "too promotional",
};

const phrasesFor = (reasons: string[], phrases: Record<string, string>) =>
  [...new Set(reasons)].map((r) => phrases[r]).filter((p): p is string => !!p).slice(0, 2);

/**
 * The recap without a model: what was worth it and what wasn't, in the user's
 * own reasons. Null when nothing has a verdict (the letter's default P.S. stands).
 */
export function fallbackRecap(pieces: { title: string; vote: ReviewVote | null; reasons: string[] }[]): string | null {
  const worth = pieces.filter((p) => p.vote === "interested");
  const not = pieces.filter((p) => p.vote === "not_interested");
  const parts: string[] = [];
  if (worth.length) {
    const why = phrasesFor(worth.flatMap((w) => w.reasons), REASON_PHRASES);
    const reason = why.length ? `, for ${why.join(" and ")}` : "";
    if (worth.length === 1) parts.push(`You marked “${worth[0]!.title}” worth it${reason}.`);
    else if (worth.length === 2) parts.push(`You marked “${worth[0]!.title}” and “${worth[1]!.title}” worth it${reason}.`);
    else parts.push(`You marked ${worth.length} pieces worth it, including “${worth[0]!.title}”${reason}.`);
  }
  if (not.length) {
    const why = phrasesFor(not.flatMap((n) => n.reasons), DISLIKE_PHRASES);
    const reason = why.length ? `: ${why.join(" and ")}` : "";
    if (not.length === 1) parts.push(`“${not[0]!.title}” wasn't for you${reason}.`);
    else if (not.length === 2) parts.push(`“${not[0]!.title}” and “${not[1]!.title}” weren't for you${reason}.`);
    else parts.push(`${not.length} pieces weren't for you${reason}.`);
  }
  return parts.length ? parts.join(" ") : null;
}

export interface MixFeedback {
  vote: ReviewVote;
  reasons: string[];
  topic: string | null;
  publisherName: string;
  at: Date;
}

const shortDate = (d: Date, timeZone: string) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });

/**
 * "Fewer beginner-level pieces, per your feedback on 12 Oct." Names at most
 * two changes from reasoned dislikes since the previous letter, and the
 * leanings the user picked. Null when nothing changed.
 */
export function whyThisMix({ feedback, chosenLeanings, timeZone = "UTC" }: { feedback: MixFeedback[]; chosenLeanings: string[]; timeZone?: string }): string | null {
  const changes: string[] = [];
  let latest: Date | null = null;
  for (const f of feedback) {
    if (f.vote !== "not_interested") continue;
    for (const r of f.reasons) {
      const change =
        r === "too_basic"
          ? "Fewer beginner-level pieces"
          : r === "too_long"
            ? "Shorter pieces"
            : r === "not_my_topic" && f.topic
              ? `Less on ${f.topic.toLowerCase()}`
              : r === "too_promotional"
                ? "Fewer promotional pieces"
                : r === "not_credible"
                  ? `Less from ${f.publisherName}`
                  : r === "already_knew"
                    ? "Fewer basics you already know"
                    : null;
      if (change && !changes.includes(change)) {
        changes.push(change);
        if (!latest || f.at > latest) latest = f.at;
      }
    }
  }
  const parts: string[] = [];
  if (changes.length) {
    const what = changes.slice(0, 2).join("; ").toLowerCase();
    parts.push(`${what[0]!.toUpperCase()}${what.slice(1)}, per your feedback on ${shortDate(latest!, timeZone)}.`);
  }
  if (chosenLeanings.length) {
    const list = chosenLeanings.slice(0, 2).map((l) => `“${l}”`).join(" and ");
    parts.push(`More of ${list}, as you asked.`);
  }
  return parts.length ? parts.join(" ") : null;
}
