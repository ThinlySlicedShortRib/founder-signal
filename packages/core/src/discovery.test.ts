import { describe, expect, it } from "vitest";
import {
  acceptableResults,
  blockedDomainsFor,
  type DiscoveryBrief,
  fallbackQueries,
  GLOBAL_BLOCKED_DOMAINS,
  hostOf,
  isBlockedHost,
  MAX_BLOCKED_DOMAINS_PER_SEARCH,
  MAX_QUERIES_PER_LETTER,
  MAX_WEB_SEARCHES_PER_LETTER,
  normalizeQuery,
  type PublisherRecord,
  publisherVerdict,
  selectQueries,
  userPublisherVerdict,
} from "./discovery.ts";
import { fallbackWhyPicked } from "./letter-copy.ts";
import { EXPLORATION_MIN_FIT, fitScore, type RankCandidate, rankCandidates, type RankProfile, scoreCandidate } from "./ranking.ts";

const NOW = new Date("2026-10-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

// ── Queries ─────────────────────────────────────────────────────────────────

describe("normalizeQuery", () => {
  it("gives reordered and inflected queries the same key", () => {
    expect(normalizeQuery("Pricing a productized service")).toBe(normalizeQuery("productized services pricing"));
    expect(normalizeQuery("  How to PRICE   consulting ")).toBe(normalizeQuery("consulting pricing"));
  });

  it("keeps different queries apart", () => {
    expect(normalizeQuery("pricing consulting")).not.toBe(normalizeQuery("hiring consulting"));
  });
});

describe("fallbackQueries", () => {
  const brief: DiscoveryBrief = { role: "Founder", lately: "moving from consulting to a product", topics: ["pricing", "hiring"], facts: [], liked: [], leanings: ["cold email"] };

  it("writes queries from lately, leanings and topics, in that order", () => {
    const q = fallbackQueries(brief);
    expect(q.map((x) => x.origin)).toEqual(["lately", "leaning", "topic", "topic"]);
    expect(q[0]).toEqual({ text: "moving from consulting to a product case study", origin: "lately", originDetail: "moving from consulting to a product" });
    expect(q[2]!.text).toBe("pricing first-hand lessons for a founder");
  });

  it("is capped and empty when the brief is", () => {
    expect(fallbackQueries(brief, 2)).toHaveLength(2);
    expect(fallbackQueries({ role: null, lately: null, topics: [], facts: [], liked: [], leanings: [] })).toEqual([]);
  });
});

describe("selectQueries", () => {
  const q = (text: string) => ({ text, origin: "topic" as const, originDetail: null });

  it("runs up to the per-letter cap and marks the rest", () => {
    const generated = ["pricing", "hiring", "sales", "churn", "fundraising", "onboarding"].map(q);
    const out = selectQueries(generated, [], { now: NOW });
    expect(out.filter((x) => x.decision === "run")).toHaveLength(MAX_QUERIES_PER_LETTER);
    expect(out.slice(MAX_QUERIES_PER_LETTER).every((x) => x.decision === "skipped_cap")).toBe(true);
  });

  it("caps billed web searches at 5–10 per letter", () => {
    expect(MAX_WEB_SEARCHES_PER_LETTER).toBeGreaterThanOrEqual(5);
    expect(MAX_WEB_SEARCHES_PER_LETTER).toBeLessThanOrEqual(10);
  });

  it("skips duplicates, queries run recently, and queries that recently found nothing", () => {
    const history = [
      { normalizedQuery: normalizeQuery("hiring engineers"), ranAt: daysAgo(2), acceptedCount: 4 },
      { normalizedQuery: normalizeQuery("sales calls"), ranAt: daysAgo(10), acceptedCount: 0 },
      { normalizedQuery: normalizeQuery("churn"), ranAt: daysAgo(10), acceptedCount: 3 },
      { normalizedQuery: normalizeQuery("onboarding"), ranAt: daysAgo(40), acceptedCount: 0 },
    ];
    const out = selectQueries([q("pricing"), q("Pricing"), q("engineers hiring"), q("sales call"), q("churn"), q("onboarding")], history, { now: NOW });
    expect(out.map((x) => x.decision)).toEqual(["run", "duplicate", "skipped_recent", "skipped_stale", "run", "run"]);
  });

  it("doesn't count skipped queries toward the cap", () => {
    const history = [{ normalizedQuery: normalizeQuery("pricing"), ranAt: daysAgo(1), acceptedCount: 1 }];
    const out = selectQueries([q("pricing"), q("hiring"), q("sales")], history, { now: NOW, cap: 2 });
    expect(out.map((x) => x.decision)).toEqual(["skipped_recent", "run", "run"]);
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe("blocked domains", () => {
  it("matches a domain and its subdomains only", () => {
    expect(isBlockedHost("blog.contentfarm.com", ["contentfarm.com"])).toBe(true);
    expect(isBlockedHost("contentfarm.com", ["contentfarm.com"])).toBe(true);
    expect(isBlockedHost("notcontentfarm.com", ["contentfarm.com"])).toBe(false);
  });

  it("combines global, catalog and user blocks, drops YouTube keys and caps the list", () => {
    const list = blockedDomainsFor(["farm.test", "youtube:UC123"], ["mine.test", "farm.test"]);
    expect(list).toEqual([...GLOBAL_BLOCKED_DOMAINS, "farm.test", "mine.test"]);
    const many = Array.from({ length: 100 }, (_, i) => `d${i}.test`);
    expect(blockedDomainsFor(many, [])).toHaveLength(MAX_BLOCKED_DOMAINS_PER_SEARCH);
  });

  it("normalizes hosts", () => {
    expect(hostOf("https://WWW.Example.com/a")).toBe("example.com");
    expect(hostOf("ftp://example.com/a")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("acceptableResults", () => {
  const r = (url: string, reason = "A first-hand account") => ({ url, title: "T", reason });

  it("keeps article pages and drops blocked hosts, homepages, YouTube, empty reasons and repeats", () => {
    const out = acceptableResults(
      [
        r("https://good.test/post/1"),
        r("https://good.test/post/1#comments"),
        r("https://sub.blocked.test/post"),
        r("https://good.test/"),
        r("https://www.youtube.com/watch?v=abc"),
        r("https://other.test/a", " "),
        r("javascript:alert(1)"),
        r("https://pinterest.com/pin/1"),
      ],
      ["blocked.test", ...GLOBAL_BLOCKED_DOMAINS],
    );
    expect(out.map((x) => x.url)).toEqual(["https://good.test/post/1"]);
  });
});

// ── Publisher catalog ───────────────────────────────────────────────────────

const record = (over: Partial<PublisherRecord> = {}): PublisherRecord => ({
  status: "candidate",
  extractionsOk: 1,
  extractionsFailed: 0,
  verificationsPassed: 0,
  verificationsFailed: 0,
  interestedCount: 0,
  notInterestedCount: 0,
  substantiveCount: 0,
  lowQualityCount: 0,
  ...over,
});

describe("publisherVerdict", () => {
  it("leaves a new candidate alone", () => {
    expect(publisherVerdict(record())).toEqual({ status: "candidate", reason: null });
  });

  it("moves candidate → trial after one well-rated item", () => {
    expect(publisherVerdict(record({ substantiveCount: 1 }))).toEqual({ status: "trial", reason: "well_rated_item" });
    expect(publisherVerdict(record({ interestedCount: 1 }))).toEqual({ status: "trial", reason: "well_rated_item" });
    // Not while the bad outweighs it.
    expect(publisherVerdict(record({ substantiveCount: 1, notInterestedCount: 1 })).status).toBe("candidate");
  });

  it("moves trial → trusted after several good items with little bad", () => {
    expect(publisherVerdict(record({ status: "trial", substantiveCount: 3, interestedCount: 1 }))).toEqual({ status: "trusted", reason: "several_good_items" });
    expect(publisherVerdict(record({ status: "trial", substantiveCount: 3, interestedCount: 1, notInterestedCount: 2 })).status).toBe("trial");
  });

  it("goes candidate → trusted in one evaluation when the evidence is already there", () => {
    expect(publisherVerdict(record({ substantiveCount: 5 })).status).toBe("trusted");
  });

  it("blocks globally for repeated quality, verification or extraction failures", () => {
    expect(publisherVerdict(record({ lowQualityCount: 3, substantiveCount: 1 }))).toEqual({ status: "blocked", reason: "low_quality" });
    expect(publisherVerdict(record({ status: "trusted", verificationsFailed: 3, verificationsPassed: 1 }))).toEqual({ status: "blocked", reason: "failed_verification" });
    expect(publisherVerdict(record({ extractionsOk: 0, extractionsFailed: 4 }))).toEqual({ status: "blocked", reason: "extraction_failures" });
    // Mostly fine: not blocked.
    expect(publisherVerdict(record({ lowQualityCount: 3, substantiveCount: 5 })).status).not.toBe("blocked");
    expect(publisherVerdict(record({ extractionsOk: 0, extractionsFailed: 3 })).status).toBe("candidate");
  });

  it("doesn't block globally for votes, and keeps a block", () => {
    expect(publisherVerdict(record({ notInterestedCount: 10 })).status).toBe("candidate");
    expect(publisherVerdict(record({ status: "blocked", substantiveCount: 10 }))).toEqual({ status: "blocked", reason: null });
  });

  it("never demotes", () => {
    expect(publisherVerdict(record({ status: "trusted" })).status).toBe("trusted");
    expect(publisherVerdict(record({ status: "trial" })).status).toBe("trial");
  });
});

describe("userPublisherVerdict", () => {
  it("blocks for the user after two distrust votes", () => {
    expect(userPublisherVerdict({ interested: 3, notInterested: 2, distrusted: 2 })).toEqual({ blocked: true, reason: "distrusted" });
  });

  it("blocks after three negative votes with nothing liked", () => {
    expect(userPublisherVerdict({ interested: 0, notInterested: 3, distrusted: 0 })).toEqual({ blocked: true, reason: "not_interested" });
    expect(userPublisherVerdict({ interested: 1, notInterested: 3, distrusted: 0 }).blocked).toBe(false);
    expect(userPublisherVerdict({ interested: 0, notInterested: 2, distrusted: 1 }).blocked).toBe(false);
  });
});

// ── Explore vs exploit in ranking ───────────────────────────────────────────

const candidate = (over: Partial<RankCandidate> & { itemId: string }): RankCandidate => ({
  kind: "article",
  title: "Untitled",
  tags: [],
  excerpt: null,
  publisherId: `pub-${over.itemId}`,
  publisherName: `Publisher ${over.itemId}`,
  authorKey: null,
  sourceMode: "more_like_this",
  publishedAt: daysAgo(1),
  quality: null,
  depth: null,
  minutes: 6,
  ...over,
});
const profile = (over: Partial<RankProfile> = {}): RankProfile => ({
  topics: [
    { topic: "pricing", weight: 1 },
    { topic: "hiring", weight: 1 },
    { topic: "sales", weight: 1 },
  ],
  lately: null, leanings: [], reviews: [], ...over });
const discovered = (itemId: string, over: Partial<RankCandidate> = {}) =>
  candidate({
    itemId,
    sourceMode: null,
    discoveredReason: "A founder's numbers on pricing a service",
    catalog: { status: "candidate", good: 0, bad: 0 },
    ...over,
  });

describe("discovery signals", () => {
  it("adds a discovered signal with the search's reason, and an uncertainty bonus that shrinks with evidence", () => {
    const fresh = scoreCandidate(discovered("a", { title: "Pricing a service" }), profile(), NOW);
    expect(fresh.signals).toContainEqual({ kind: "discovered", weight: 0.5, detail: "A founder's numbers on pricing a service" });
    expect(fresh.signals).toContainEqual({ kind: "exploration", weight: 1, detail: "Publisher a" });
    const seasoned = scoreCandidate(discovered("b", { catalog: { status: "trial", good: 3, bad: 0 } }), profile(), NOW);
    expect(seasoned.signals.find((s) => s.kind === "exploration")!.weight).toBeCloseTo(0.5);
    expect(seasoned.signals.find((s) => s.kind === "publisher_record")!.weight).toBeCloseTo(0.6);
  });

  it("gives a trusted publisher its record but no exploration bonus", () => {
    const s = scoreCandidate(discovered("a", { catalog: { status: "trusted", good: 6, bad: 0 } }), profile(), NOW);
    expect(s.signals.some((x) => x.kind === "exploration")).toBe(false);
    expect(s.signals.find((x) => x.kind === "publisher_record")!.weight).toBeCloseTo(0.75);
  });

  it("counts a poor record against a publisher", () => {
    const s = scoreCandidate(discovered("a", { catalog: { status: "trial", good: 1, bad: 3 } }), profile(), NOW);
    expect(s.signals.find((x) => x.kind === "publisher_record")!.weight).toBeLessThan(0);
  });

  it("measures fit without recency or the discovery bonuses", () => {
    const s = scoreCandidate(discovered("a", { title: "Pricing a service" }), profile(), NOW);
    expect(fitScore(s)).toBe(3);
    expect(fitScore(scoreCandidate(discovered("b", { title: "Gardening" }), profile(), NOW))).toBe(0);
  });

  it("matches the 'something new' leaning to unproven discovered publishers", () => {
    const p = profile({ leanings: ["Something new"] });
    expect(scoreCandidate(discovered("a"), p, NOW).signals.some((s) => s.kind === "leaning")).toBe(true);
    expect(scoreCandidate(candidate({ itemId: "b" }), p, NOW).signals.some((s) => s.kind === "leaning")).toBe(false);
  });

  it("explains a discovered pick without repeating the model's reason", () => {
    expect(fallbackWhyPicked([{ kind: "discovered", detail: "Grew to 30 clients" }])).toBe("A new source, found by searching the web for what you're into.");
    expect(fallbackWhyPicked([{ kind: "topic", detail: "pricing" }, { kind: "discovered", detail: "x" }])).toBe("It's about pricing, one of your topics.");
  });
});

describe("exploration slot", () => {
  const followed = [
    candidate({ itemId: "f1", title: "Pricing your first contract", sourceMode: "follow_closely", publishedAt: daysAgo(0) }),
    candidate({ itemId: "f2", title: "Hiring your first engineer", sourceMode: "follow_closely", publishedAt: daysAgo(0) }),
    candidate({ itemId: "f3", title: "Sales calls that close", sourceMode: "follow_closely", publishedAt: daysAgo(0) }),
  ];

  it("keeps one slot for the best piece from an unproven discovered publisher", () => {
    const pick = discovered("d1", { title: "Pricing lessons", publishedAt: daysAgo(200) });
    const weaker = discovered("d2", { title: "Pricing basics", publishedAt: daysAgo(300), catalog: { status: "trial", good: 5, bad: 3 } });
    const { picks } = rankCandidates([...followed, weaker, pick], profile(), { now: NOW, count: 3 });
    // It wouldn't make the cut on score alone.
    expect(scoreCandidate(pick, profile(), NOW).score).toBeLessThan(scoreCandidate(followed[2]!, profile(), NOW).score);
    expect(picks.map((p) => p.itemId)).toContain("d1");
    expect(picks.map((p) => p.itemId)).not.toContain("d2");
    expect(picks).toHaveLength(3);
  });

  it("doesn't give the slot to a piece that doesn't fit the user", () => {
    const offTopic = discovered("d1", { title: "Gardening tips" });
    expect(fitScore(scoreCandidate(offTopic, profile(), NOW))).toBeLessThan(EXPLORATION_MIN_FIT);
    expect(rankCandidates([...followed, offTopic], profile(), { now: NOW, count: 3 }).picks.map((p) => p.itemId)).not.toContain("d1");
  });

  it("isn't used for a one-piece letter, or for trusted or user-added publishers", () => {
    const pick = discovered("d1", { title: "Pricing lessons", publishedAt: daysAgo(200) });
    expect(rankCandidates([...followed, pick], profile(), { now: NOW, count: 1 }).picks.map((p) => p.itemId)).toEqual(["f1"]);
    const trusted = discovered("d2", { title: "Pricing lessons", publishedAt: daysAgo(200), catalog: { status: "trusted", good: 9, bad: 0 } });
    expect(rankCandidates([...followed, trusted], profile(), { now: NOW, count: 3 }).picks.map((p) => p.itemId)).not.toContain("d2");
  });

  it("can be turned off", () => {
    const pick = discovered("d1", { title: "Pricing lessons", publishedAt: daysAgo(200) });
    expect(rankCandidates([...followed, pick], profile(), { now: NOW, count: 3, explorationSlots: 0 }).picks.map((p) => p.itemId)).not.toContain("d1");
  });
});
