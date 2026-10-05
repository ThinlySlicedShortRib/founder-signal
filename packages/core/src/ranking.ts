import type { DislikeReason, LikeReason, ReviewVote, SourceMode } from "@fs/schema";
import type { PublisherStatus } from "./discovery.ts";
import { topicsFromText } from "./onboarding.ts";
import { displayTopic, phraseMatches, stemSet } from "./text-match.ts";

/**
 * Ranking v1 (build plan §6.4): a transparent weighted heuristic, then a
 * greedy rerank under constraints. Every pick keeps its top contributing
 * signals so the app can say why it was picked without showing scores.
 *
 *   score = topic + lately + leaning + source mode + review affinity
 *         + creator affinity + recency + quality + depth/time fit − penalties
 *
 * Goal similarity by embedding (w1) comes later; for now topics are matched
 * on words against the user's topics, their "lately" and the previous
 * letter's chosen leanings.
 *
 * Explore vs exploit (§6.3a.5): a publisher discovery found is scored from
 * its record (good items against bad), and one still on `candidate` or
 * `trial` gets an uncertainty bonus that shrinks as evidence comes in, so a
 * new publisher has a real chance. One slot per letter is kept for the best
 * of those (the exploration slot), as long as it's relevant at all.
 */

export const RANKING_WEIGHTS = {
  /** × the topic's weight (1 for an explicit topic). */
  topic: 3,
  lately: 2,
  leaning: 1.5,
  sourceMode: { follow_closely: 1.5, more_like_this: 1, occasional: 0.3 } satisfies Record<SourceMode, number>,
  /** Per earlier "interested" review on an overlapping topic, capped. */
  likedTopic: 0.5,
  likedTopicCap: 2,
  /** Per earlier "not my topic" on an overlapping topic, capped. */
  dislikedTopic: -1,
  dislikedTopicCap: -3,
  alreadyKnew: -0.3,
  likedCreator: 1,
  likedPublisher: 0.3,
  /** "Not credible" or "too promotional" on this publisher. */
  distrustedPublisher: -2,
  /** Half-life in days for the recency bonus. */
  recency: 1,
  recencyHalfLifeDays: 7,
  undatedRecency: 0.3,
  quality: { substantive: 0.5, rewritten: -1 } as Record<string, number>,
  tooBasic: -1,
  likesDepth: 0.3,
  tooLong: -1,
  likesConcise: 0.3,
  likesVideo: 0.5,
  /** Discovery found it for this user; the detail is the search's reason. */
  discovered: 0.5,
  /** × (good − bad) / (good + bad + 2) from a discovered publisher's record. */
  publisherRecord: 1,
  /** × 1/√(1 + evidence) for a discovered publisher still on candidate or trial. */
  exploration: 1,
  /** From the shared pool (letter-supply.ts): found for someone else, so the user's own sources win. */
  sharedPool: -1,
} as const;

/**
 * The exploration slot only goes to a piece whose fit (its score without
 * recency and the discovery bonuses) is at least this: a leaning, "lately" or
 * topic match. It has to fit the user somehow.
 */
export const EXPLORATION_MIN_FIT = 1;

/** Signals about how new or unproven a piece is, rather than how well it fits the user. */
const NOT_FIT: ReadonlySet<PickSignal["kind"]> = new Set(["recency", "discovered", "publisher_record", "exploration", "shared_pool"]);

/** A scored piece's fit to the user: its score without recency and the discovery bonuses. */
export function fitScore(s: Pick<ScoredCandidate, "signals">): number {
  return s.signals.filter((x) => !NOT_FIT.has(x.kind)).reduce((sum, x) => sum + x.weight, 0);
}

/** Above this many minutes a piece counts as long for "too long" feedback. */
export const LONG_PIECE_MINUTES = 12;
export const SHORT_PIECE_MINUTES = 7;

export interface RankCandidate {
  itemId: string;
  kind: "article" | "video";
  title: string;
  tags: string[];
  /** A little of the text (the excerpt), for matching. */
  excerpt: string | null;
  publisherId: string;
  publisherName: string;
  authorKey: string | null;
  /** The user's closest link to it: the mode of the source it came from. */
  sourceMode: SourceMode | null;
  publishedAt: Date | null;
  quality: string | null;
  depth: string | null;
  minutes: number | null;
  /** Set when discovery found it for this user: the search's one-line reason. */
  discoveredReason?: string | null;
  /** The publisher's catalog standing, for publishers discovery found (§6.3a); null for ones the user added. */
  catalog?: { status: PublisherStatus; good: number; bad: number } | null;
  /** From the shared pool (letter-supply.ts) rather than the user's own sources or discoveries. */
  shared?: boolean;
}

export interface RankReview {
  vote: ReviewVote;
  reasons: (LikeReason | DislikeReason | string)[];
  tags: string[];
  title: string | null;
  publisherId: string;
  authorKey: string | null;
}

export interface RankProfile {
  topics: { topic: string; weight: number }[];
  lately: string | null;
  /** What the user picked in the previous letter's P.S. ("Tomorrow, more of"). */
  leanings: string[];
  /** Recent reviews, newest first. */
  reviews: RankReview[];
}

export interface PickSignal {
  kind:
    | "topic"
    | "lately"
    | "leaning"
    | "source_mode"
    | "liked_topic"
    | "disliked_topic"
    | "already_knew"
    | "liked_creator"
    | "liked_publisher"
    | "distrusted_publisher"
    | "recency"
    | "quality"
    | "depth"
    | "length"
    | "format"
    | "discovered"
    | "publisher_record"
    | "exploration"
    | "shared_pool";
  weight: number;
  detail: string | null;
}

export interface ScoredCandidate {
  itemId: string;
  score: number;
  /** The piece's topic for the letter: the user topic it matched, else its first tag. */
  topic: string;
  publisherId: string;
  /** Positive contributions first, strongest first. */
  signals: PickSignal[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Leanings the P.S. offers that mean something other than a topic. */
const FORMAT_LEANINGS: [RegExp, (c: RankCandidate) => boolean][] = [
  [/^short(er)? reads?$/i, (c) => c.minutes !== null && c.minutes <= SHORT_PIECE_MINUTES],
  [/^(more )?videos?$/i, (c) => c.kind === "video"],
  [/^deeper dives?$/i, (c) => c.depth === "advanced" || (c.minutes ?? 0) > LONG_PIECE_MINUTES],
  [/^something new$/i, (c) => isExploratory(c)],
];

/** A piece from a publisher discovery found that hasn't proven itself yet: what the exploration slot is for. */
export function isExploratory(c: Pick<RankCandidate, "catalog">): boolean {
  return !!c.catalog && (c.catalog.status === "candidate" || c.catalog.status === "trial");
}

export function scoreCandidate(c: RankCandidate, profile: RankProfile, now: Date): ScoredCandidate {
  const W = RANKING_WEIGHTS;
  const signals: PickSignal[] = [];
  const add = (kind: PickSignal["kind"], weight: number, detail: string | null = null) => {
    if (weight !== 0) signals.push({ kind, weight: round(weight), detail });
  };

  const stems = stemSet(c.title, c.tags.join(" "), c.excerpt);
  const textTopics = topicsFromText(`${c.title} ${c.tags.join(" ")}`);

  // Topics: the strongest matching topic of the user's.
  let topic: string | null = null;
  let best = 0;
  for (const t of profile.topics) {
    if (t.weight <= 0) continue;
    const matched = phraseMatches(t.topic, stems) || textTopics.some((x) => x.toLowerCase() === t.topic.toLowerCase());
    if (matched && t.weight > best) {
      best = t.weight;
      topic = t.topic;
    }
  }
  if (topic) add("topic", W.topic * best, topic);
  // Negative topic weights (learned from dislikes, M6) act as penalties.
  for (const t of profile.topics) {
    if (t.weight < 0 && phraseMatches(t.topic, stems)) add("disliked_topic", W.topic * t.weight, t.topic);
  }

  if (profile.lately && phraseMatches(profile.lately, stems)) add("lately", W.lately, profile.lately.trim().slice(0, 120));

  for (const leaning of profile.leanings) {
    const format = FORMAT_LEANINGS.find(([re]) => re.test(leaning.trim()));
    const hit = format ? format[1](c) : !!phraseMatches(leaning, stems);
    if (hit) {
      add("leaning", W.leaning, leaning);
      break;
    }
  }

  if (c.sourceMode) add("source_mode", W.sourceMode[c.sourceMode], c.sourceMode);

  // Reviews: reasons carry the most weight (§6.4).
  let liked = 0;
  let disliked = 0;
  let knew = 0;
  let likedCreator = false;
  let likedPublisher = false;
  let distrusted = false;
  let tooBasic = false;
  let likesDepth = false;
  let tooLong = false;
  let likesConcise = false;
  let likesVideo = false;
  for (const r of profile.reviews) {
    const overlap = r.tags.some((t) => phraseMatches(t, stems));
    if (r.vote === "interested") {
      if (overlap) liked++;
      if (r.authorKey && r.authorKey === c.authorKey && r.reasons.includes("creator")) likedCreator = true;
      else if (r.publisherId === c.publisherId) likedPublisher = true;
      if (r.reasons.includes("depth")) likesDepth = true;
      if (r.reasons.includes("concise")) likesConcise = true;
      if (r.reasons.includes("video")) likesVideo = true;
    } else {
      if (overlap && r.reasons.includes("not_my_topic")) disliked++;
      if (overlap && r.reasons.includes("already_knew")) knew++;
      if (r.publisherId === c.publisherId && (r.reasons.includes("not_credible") || r.reasons.includes("too_promotional"))) distrusted = true;
      if (r.reasons.includes("too_basic")) tooBasic = true;
      if (r.reasons.includes("too_long")) tooLong = true;
    }
  }
  if (liked) add("liked_topic", Math.min(W.likedTopicCap, liked * W.likedTopic));
  if (disliked) add("disliked_topic", Math.max(W.dislikedTopicCap, disliked * W.dislikedTopic));
  if (knew) add("already_knew", knew * W.alreadyKnew);
  if (likedCreator) add("liked_creator", W.likedCreator);
  else if (likedPublisher) add("liked_publisher", W.likedPublisher, c.publisherName);
  if (distrusted) add("distrusted_publisher", W.distrustedPublisher, c.publisherName);

  if (c.publishedAt) {
    const ageDays = Math.max(0, (now.getTime() - c.publishedAt.getTime()) / 86_400_000);
    add("recency", W.recency * 0.5 ** (ageDays / W.recencyHalfLifeDays));
  } else {
    add("recency", W.undatedRecency);
  }

  const q = c.quality ? (W.quality[c.quality] ?? 0) : 0;
  if (q) add("quality", q, c.quality);

  if (tooBasic && c.depth === "introductory") add("depth", W.tooBasic, "introductory");
  else if (likesDepth && c.depth === "advanced") add("depth", W.likesDepth, "advanced");

  if (tooLong && (c.minutes ?? 0) > LONG_PIECE_MINUTES) add("length", W.tooLong, `${c.minutes} min`);
  else if (likesConcise && c.minutes !== null && c.minutes <= SHORT_PIECE_MINUTES) add("length", W.likesConcise, `${c.minutes} min`);

  if (likesVideo && c.kind === "video") add("format", W.likesVideo, "video");

  if (c.discoveredReason) add("discovered", W.discovered, c.discoveredReason);
  if (c.catalog) {
    const { good, bad } = c.catalog;
    add("publisher_record", (W.publisherRecord * (good - bad)) / (good + bad + 2), c.publisherName);
    if (isExploratory(c)) add("exploration", W.exploration / Math.sqrt(1 + good + bad), c.publisherName);
  }

  if (c.shared) add("shared_pool", W.sharedPool);

  const score = round(signals.reduce((s, x) => s + x.weight, 0));
  signals.sort((a, b) => b.weight - a.weight);
  const fallbackTopic = c.tags[0] ?? textTopics[0] ?? (c.kind === "video" ? "Video" : "Reading");
  return { itemId: c.itemId, score, topic: displayTopic(topic ?? fallbackTopic), publisherId: c.publisherId, signals };
}

export interface RankResult {
  picks: ScoredCandidate[];
  /** The next best, in order, for substitution after verification (§6.2). */
  reserve: ScoredCandidate[];
}

/**
 * Scores every candidate and picks `count` greedily: one per publisher and
 * a new topic each time while that's possible, then a repeated publisher
 * rather than a short letter (§6.2: at least MIN_PIECES). With room for
 * two or more, the first pick is the exploration slot: the best piece from an
 * unproven discovered publisher, if one fits at least EXPLORATION_MIN_FIT.
 * Ties break on item ID so ranking is deterministic.
 */
export function rankCandidates(
  candidates: RankCandidate[],
  profile: RankProfile,
  { now, count = 3, reserve = 6, explorationSlots = 1 }: { now: Date; count?: number; reserve?: number; explorationSlots?: number },
): RankResult {
  const exploratory = new Set(candidates.filter(isExploratory).map((c) => c.itemId));
  const scored = candidates
    .map((c) => scoreCandidate(c, profile, now))
    .sort((a, b) => b.score - a.score || (a.itemId < b.itemId ? -1 : 1));

  const picks: ScoredCandidate[] = [];
  const publishers = new Set<string>();
  const topics = new Set<string>();
  const take = (s: ScoredCandidate) => {
    picks.push(s);
    publishers.add(s.publisherId);
    topics.add(s.topic.toLowerCase());
  };
  if (count >= 2) {
    for (const s of scored) {
      if (picks.length >= Math.min(explorationSlots, count - 1)) break;
      if (exploratory.has(s.itemId) && fitScore(s) >= EXPLORATION_MIN_FIT && !publishers.has(s.publisherId)) take(s);
    }
  }
  for (const s of scored) {
    if (picks.length >= count) break;
    if (!publishers.has(s.publisherId) && !topics.has(s.topic.toLowerCase())) take(s);
  }
  for (const s of scored) {
    if (picks.length >= count) break;
    if (!picks.includes(s) && !publishers.has(s.publisherId)) take(s);
  }
  for (const s of scored) {
    if (picks.length >= count) break;
    if (!picks.includes(s)) take(s);
  }
  // Keep picks in score order.
  picks.sort((a, b) => b.score - a.score || (a.itemId < b.itemId ? -1 : 1));
  return { picks, reserve: scored.filter((s) => !picks.includes(s)).slice(0, reserve) };
}

/**
 * Picks a substitute from the reserve for a piece that failed verification:
 * the best untried one from a publisher not already in the letter, or else
 * the best untried one (a repeated publisher beats a short letter).
 */
export function nextSubstitute(reserve: ScoredCandidate[], kept: { publisherId: string }[], tried: ReadonlySet<string>): ScoredCandidate | null {
  const used = new Set(kept.map((k) => k.publisherId));
  return reserve.find((r) => !tried.has(r.itemId) && !used.has(r.publisherId)) ?? reserve.find((r) => !tried.has(r.itemId)) ?? null;
}
