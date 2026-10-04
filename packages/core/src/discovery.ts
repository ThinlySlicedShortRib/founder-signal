import { keywords } from "./text-match.ts";

/**
 * Open web discovery and the publisher catalog (build plan §6.3a): the
 * deterministic parts. Which queries to run, which results to keep, and how
 * a discovered publisher moves between `candidate`, `trial`, `trusted` and
 * `blocked`. No I/O, so every rule is unit-tested.
 */

// ── Budget (§6.3a.6) ────────────────────────────────────────────────────────

/** Discovery for a letter starts this long before it's due (assembly starts 45 minutes before). */
export const DISCOVERY_LEAD_HOURS = 3;
/** Queries the generator is asked for; more than are searched, so stale ones can be skipped. */
export const MAX_QUERIES_GENERATED = 8;
/** Queries searched per letter (new searches and cache hits both count). */
export const MAX_QUERIES_PER_LETTER = 4;
/** The web search tool's `max_uses` per query. */
export const WEB_SEARCHES_PER_QUERY = 2;
/** The hard cap on billed web searches per letter: 4 × 2 = 8 (§6.3a: about 5–10). */
export const MAX_WEB_SEARCHES_PER_LETTER = MAX_QUERIES_PER_LETTER * WEB_SEARCHES_PER_QUERY;
/** Results asked for per query. */
export const MAX_RESULTS_PER_QUERY = 6;
/** Pages linked to a user per run, across all its queries. */
export const MAX_LINKS_PER_RUN = 15;
/** A search's results are reused across users for this long. */
export const SEARCH_CACHE_TTL_DAYS = 7;
/** A query this user ran within this many days isn't run again (its results are already linked). */
export const RECENT_QUERY_DAYS = SEARCH_CACHE_TTL_DAYS;
/** A query that found nothing new within this many days is skipped. */
export const STALE_QUERY_DAYS = 21;
/** Discovered pages stay letter candidates for this long after they're found (they're often evergreen, so not by publish date). */
export const DISCOVERED_CANDIDATE_DAYS = 14;
/** The web search tool takes a bounded `blocked_domains` list; the rest are filtered after the search. */
export const MAX_BLOCKED_DOMAINS_PER_SEARCH = 60;

/**
 * Never searched or linked, for anyone: login walls, social sites and known
 * content farms whose pages don't extract into anything worth reading.
 * Publishers blocked by the catalog rules are added from the database.
 */
export const GLOBAL_BLOCKED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "quora.com",
  "ezinearticles.com",
  "hubpages.com",
  "articlesbase.com",
] as const;

// ── Queries ─────────────────────────────────────────────────────────────────

/** Where a query came from in the user's brief. */
export const queryOrigins = ["role", "lately", "topic", "fact", "review", "leaning"] as const;
export type QueryOrigin = (typeof queryOrigins)[number];

/** What the query generator is given: only what the user told us and how they voted, never their name or email. */
export interface DiscoveryBrief {
  role: string | null;
  lately: string | null;
  topics: string[];
  /** Imported facts the user kept. */
  facts: string[];
  /** Recent "interested" reviews: the piece's title and topic tags, and the reasons they gave. */
  liked: { title: string; tags: string[]; reasons: string[] }[];
  /** What they picked in the previous letter's P.S. ("Tomorrow, more of"). */
  leanings: string[];
}

export interface GeneratedQuery {
  text: string;
  origin: QueryOrigin;
  /** The user's words or the topic it came from. */
  originDetail: string | null;
}

/**
 * The cache key for a query: its keywords, stemmed, deduplicated and sorted,
 * so "pricing a productized service" and "productized services pricing" share
 * one search.
 */
export function normalizeQuery(text: string): string {
  return [...new Set(keywords(text))].sort().join(" ");
}

/** Queries from the brief with no model: the fallback when the generator fails. */
export function fallbackQueries(brief: DiscoveryBrief, max = MAX_QUERIES_GENERATED): GeneratedQuery[] {
  const who = brief.role ? ` for a ${brief.role.toLowerCase()}` : " for founders";
  const out: GeneratedQuery[] = [];
  if (brief.lately?.trim()) out.push({ text: `${brief.lately.trim()} case study`, origin: "lately", originDetail: brief.lately.trim() });
  for (const l of brief.leanings) out.push({ text: `${l} essay${who}`, origin: "leaning", originDetail: l });
  for (const t of brief.topics) out.push({ text: `${t} first-hand lessons${who}`, origin: "topic", originDetail: t });
  return out.filter((q) => normalizeQuery(q.text)).slice(0, max);
}

/** A query this user ran before, from `discovery_query`. */
export interface QueryHistory {
  normalizedQuery: string;
  ranAt: Date;
  /** Pages it newly linked to the user. */
  acceptedCount: number;
}

export type QueryDecision = "run" | "duplicate" | "skipped_recent" | "skipped_stale" | "skipped_cap";

/**
 * Which generated queries to search (§6.3a.1): in the generator's order, at
 * most `cap`, skipping repeats within the run, queries this user ran in the
 * last RECENT_QUERY_DAYS (their results are already linked), and queries that
 * found nothing new in the last STALE_QUERY_DAYS.
 */
export function selectQueries(
  generated: GeneratedQuery[],
  history: QueryHistory[],
  { now, cap = MAX_QUERIES_PER_LETTER }: { now: Date; cap?: number },
): { query: GeneratedQuery; normalized: string; decision: QueryDecision }[] {
  const ageDays = (d: Date) => (now.getTime() - d.getTime()) / 86_400_000;
  const seen = new Set<string>();
  let running = 0;
  return generated.map((query) => {
    const normalized = normalizeQuery(query.text);
    const past = history.filter((h) => h.normalizedQuery === normalized);
    let decision: QueryDecision;
    if (!normalized || seen.has(normalized)) decision = "duplicate";
    else if (past.some((h) => ageDays(h.ranAt) < RECENT_QUERY_DAYS)) decision = "skipped_recent";
    else if (past.some((h) => ageDays(h.ranAt) < STALE_QUERY_DAYS && h.acceptedCount === 0)) decision = "skipped_stale";
    else if (running >= cap) decision = "skipped_cap";
    else decision = "run";
    seen.add(normalized);
    if (decision === "run") running++;
    return { query, normalized, decision };
  });
}

// ── Results ─────────────────────────────────────────────────────────────────

/** The host without `www.`, lowercase. Null for anything that isn't an http(s) URL. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Whether a host is on the list, itself or as a subdomain of a listed domain. */
export function isBlockedHost(host: string, blocked: Iterable<string>): boolean {
  for (const b of blocked) if (host === b || host.endsWith(`.${b}`)) return true;
  return false;
}

/**
 * The blocked domains for one search: the global list, then publishers
 * blocked for everyone, then the user's own, capped at what the tool takes.
 * YouTube channel keys aren't domains and are left out.
 */
export function blockedDomainsFor(globalBlocked: string[], userBlocked: string[], max = MAX_BLOCKED_DOMAINS_PER_SEARCH): string[] {
  const all = [...new Set([...GLOBAL_BLOCKED_DOMAINS, ...globalBlocked, ...userBlocked].filter((d) => d.includes(".") && !d.includes(":")))];
  return all.slice(0, max);
}

export interface SearchResultLike {
  url: string;
  title: string | null;
  reason: string;
}

/**
 * Results worth ingesting for this user: http(s) pages on hosts that aren't
 * blocked (the search's block list is capped, so it's checked again here),
 * not a site's homepage, not a YouTube page (discovery is for articles for
 * now), with a reason, one per URL.
 */
export function acceptableResults<T extends SearchResultLike>(results: T[], blocked: Iterable<string>): T[] {
  const blockedList = [...blocked];
  const seen = new Set<string>();
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (!host || isBlockedHost(host, blockedList)) return false;
    if (isBlockedHost(host, ["youtube.com", "youtu.be"])) return false;
    if (new URL(r.url).pathname.replace(/\/+$/, "") === "") return false;
    if (!r.reason.trim()) return false;
    const key = r.url.replace(/#.*$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Publisher catalog (§6.3a.4) ─────────────────────────────────────────────

export type PublisherStatus = "candidate" | "trial" | "trusted" | "blocked";

/** A publisher's record, from the `publisher` row's counters. */
export interface PublisherRecord {
  status: PublisherStatus;
  extractionsOk: number;
  extractionsFailed: number;
  verificationsPassed: number;
  verificationsFailed: number;
  interestedCount: number;
  notInterestedCount: number;
  substantiveCount: number;
  lowQualityCount: number;
}

export const PUBLISHER_RULES = {
  /** Good items (substantive by enrichment, or voted interested) to move candidate → trial. */
  trialAfterGoodItems: 1,
  /** Good items to move trial → trusted. */
  trustedAfterGoodItems: 4,
  /** …with no more than this share of its evidence bad. */
  trustedMaxBadShare: 0.25,
  /** Global block: this many low-quality items, and more than its substantive ones. */
  lowQualityBlockAt: 3,
  /** Global block: this many failed verifications, and more than passed. */
  verificationBlockAt: 3,
  /** Global block: extraction failing on most pages, after this many attempts. */
  extractionBlockMinAttempts: 4,
  extractionBlockMaxOkShare: 0.25,
} as const;

/** Items that count for a publisher, and against it. */
export function publisherEvidence(r: Omit<PublisherRecord, "status">) {
  const good = r.substantiveCount + r.interestedCount;
  const bad = r.lowQualityCount + r.notInterestedCount + r.verificationsFailed;
  return { good, bad, total: good + bad };
}

export interface PublisherVerdict {
  status: PublisherStatus;
  /** Why, for `publisher.status_reason`; null when nothing changed. */
  reason: string | null;
}

/**
 * The catalog's promotion and blocking rules for a discovered publisher.
 * Blocking is for quality failures (global); a user's negative votes only
 * block it for them (`userPublisherVerdict`). A blocked publisher stays
 * blocked, and promotions don't go backwards.
 */
export function publisherVerdict(r: PublisherRecord): PublisherVerdict {
  const R = PUBLISHER_RULES;
  if (r.status === "blocked") return { status: "blocked", reason: null };

  if (r.lowQualityCount >= R.lowQualityBlockAt && r.lowQualityCount > r.substantiveCount) return { status: "blocked", reason: "low_quality" };
  if (r.verificationsFailed >= R.verificationBlockAt && r.verificationsFailed > r.verificationsPassed) {
    return { status: "blocked", reason: "failed_verification" };
  }
  const attempts = r.extractionsOk + r.extractionsFailed;
  if (attempts >= R.extractionBlockMinAttempts && r.extractionsOk / attempts < R.extractionBlockMaxOkShare) {
    return { status: "blocked", reason: "extraction_failures" };
  }

  // One step at a time (candidate → trial → trusted), applied until it settles,
  // so a publisher whose first evaluation already shows several good items ends up trusted.
  const { good, bad, total } = publisherEvidence(r);
  let status: PublisherStatus = r.status;
  let reason: string | null = null;
  if (status === "candidate" && good >= R.trialAfterGoodItems && good > bad) {
    status = "trial";
    reason = "well_rated_item";
  }
  if (status === "trial" && good >= R.trustedAfterGoodItems && bad / total <= R.trustedMaxBadShare) {
    status = "trusted";
    reason = "several_good_items";
  }
  return { status, reason };
}

/** One user's votes on one publisher's items. */
export interface UserPublisherVotes {
  interested: number;
  notInterested: number;
  /** "Not credible" or "too promotional": about the publisher, not the topic. */
  distrusted: number;
}

export const USER_BLOCK_RULES = {
  distrustedAt: 2,
  /** Not-interested votes (other than "not my topic") with none interested. */
  notInterestedAt: 3,
} as const;

/** Whether a user's own votes block a publisher for them (§6.3a.4). */
export function userPublisherVerdict(v: UserPublisherVotes): { blocked: boolean; reason: string | null } {
  if (v.distrusted >= USER_BLOCK_RULES.distrustedAt) return { blocked: true, reason: "distrusted" };
  if (v.notInterested >= USER_BLOCK_RULES.notInterestedAt && v.interested === 0) return { blocked: true, reason: "not_interested" };
  return { blocked: false, reason: null };
}

/** Review reasons that count against a publisher rather than a topic. */
export const DISTRUST_REASONS = ["not_credible", "too_promotional"] as const;
/** Review reasons that are about the user, not the publisher, and don't count toward a block. */
export const NEUTRAL_DISLIKE_REASONS = ["not_my_topic", "already_knew"] as const;
