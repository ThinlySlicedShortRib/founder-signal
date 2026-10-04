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

/** Changes whenever a verdict on the letter's pieces changes, so the recap is rewritten lazily. */
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

/** The recap without a model: who was worth it and why, in the user's own reasons. */
export function fallbackRecap(worthIt: { title: string; reasons: string[] }[]): string | null {
  if (!worthIt.length) return null;
  const reasons = [...new Set(worthIt.flatMap((w) => w.reasons))].map((r) => REASON_PHRASES[r]).filter(Boolean) as string[];
  const why = reasons.length ? `, for ${reasons.slice(0, 2).join(" and ")}` : "";
  if (worthIt.length === 1) return `You marked “${worthIt[0]!.title}” worth it${why}.`;
  if (worthIt.length === 2) return `You marked “${worthIt[0]!.title}” and “${worthIt[1]!.title}” worth it${why}.`;
  return `You marked ${worthIt.length} pieces worth it, including “${worthIt[0]!.title}”${why}.`;
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
