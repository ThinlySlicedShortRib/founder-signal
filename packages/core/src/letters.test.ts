import { describe, expect, it } from "vitest";
import { activityLevel, activityMonth, type ActivityEvent } from "./activity.ts";
import { authorKeyFor, authorNeedsCheck, cleanAuthorName, initialsFor, provenanceLine } from "./authors.ts";
import { chapterTitle, splitChapters } from "./chapters.ts";
import { assignFeedbackCodes, FEEDBACK_CODE_PATTERN, publicationInitials } from "./feedback-codes.ts";
import {
  briefText,
  checkLetterCopy,
  checkPieceCopy,
  checkPostscript,
  fallbackHeadline,
  fallbackIntro,
  fallbackLetterCopy,
  fallbackPostscript,
  fallbackWhyPicked,
  leadSentences,
  numbersIn,
  quotesIn,
  selectPassages,
  COPY_LIMITS,
  countIntro,
  type WriterBrief,
  type WriterPiece,
} from "./letter-copy.ts";
import { fallbackRecap, leaningOptions, LEANING_MAX_CHARS, verdictSignature, whyThisMix } from "./postscript.ts";
import { nextSubstitute, type RankCandidate, rankCandidates, type RankProfile, scoreCandidate } from "./ranking.ts";
import { keywords, phraseMatches, stem, stemSet } from "./text-match.ts";

const NOW = new Date("2026-10-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** A seeded generator, so code assignment is reproducible in tests. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

describe("text matching", () => {
  it("stems common inflections together", () => {
    expect(stem("pricing")).toBe(stem("prices"));
    expect(stem("hiring")).toBe(stem("hire"));
    expect(stem("companies")).toBe(stem("company"));
  });

  it("drops stopwords and keeps short domain words", () => {
    expect(keywords("How I think about the AI tools")).toEqual(["think", "ai", "tool"]);
  });

  it("matches a short phrase only when all its words appear", () => {
    const stems = stemSet("How we priced our first B2B contract");
    expect(phraseMatches("pricing", stems)).toEqual([stem("pricing")]);
    expect(phraseMatches("first customers", stems)).toBeNull();
    expect(phraseMatches("b2b pricing", stems)).not.toBeNull();
  });

  it("needs at least two words of a longer phrase", () => {
    const stems = stemSet("Costco's membership fee is the real business model");
    expect(phraseMatches("how Costco makes money from membership", stems)).not.toBeNull();
    expect(phraseMatches("how Walmart makes money from groceries", stems)).toBeNull();
  });
});

// ── Ranking ─────────────────────────────────────────────────────────────────

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

const profile = (over: Partial<RankProfile> = {}): RankProfile => ({ topics: [], lately: null, leanings: [], reviews: [], ...over });

describe("scoreCandidate", () => {
  it("rewards a topic match by its weight and names the topic", () => {
    const p = profile({ topics: [{ topic: "pricing", weight: 1 }] });
    const hit = scoreCandidate(candidate({ itemId: "a", title: "How we priced our first contract" }), p, NOW);
    const miss = scoreCandidate(candidate({ itemId: "b", title: "Notes on gardening" }), p, NOW);
    expect(hit.score - miss.score).toBeCloseTo(3);
    expect(hit.topic).toBe("Pricing");
    expect(hit.signals[0]).toEqual({ kind: "topic", weight: 3, detail: "pricing" });
  });

  it("matches the user's own words from 'lately' and keeps them for 'why I picked this'", () => {
    const p = profile({ lately: "how Costco makes money" });
    const s = scoreCandidate(candidate({ itemId: "a", title: "The fee is the product", excerpt: "Costco makes its money on membership fees" }), p, NOW);
    expect(s.signals).toContainEqual({ kind: "lately", weight: 2, detail: "how Costco makes money" });
  });

  it("boosts the previous letter's chosen leanings, including format leanings", () => {
    const short = scoreCandidate(candidate({ itemId: "a", minutes: 4 }), profile({ leanings: ["Short reads"] }), NOW);
    const long = scoreCandidate(candidate({ itemId: "b", minutes: 25 }), profile({ leanings: ["Short reads"] }), NOW);
    expect(short.signals.some((s) => s.kind === "leaning")).toBe(true);
    expect(long.signals.some((s) => s.kind === "leaning")).toBe(false);
    const topical = scoreCandidate(candidate({ itemId: "c", title: "Sales playbooks for founders" }), profile({ leanings: ["Sales playbooks"] }), NOW);
    expect(topical.signals).toContainEqual({ kind: "leaning", weight: 1.5, detail: "Sales playbooks" });
  });

  it("weighs source modes", () => {
    const close = scoreCandidate(candidate({ itemId: "a", sourceMode: "follow_closely" }), profile(), NOW).score;
    const normal = scoreCandidate(candidate({ itemId: "b", sourceMode: "more_like_this" }), profile(), NOW).score;
    const occasional = scoreCandidate(candidate({ itemId: "c", sourceMode: "occasional" }), profile(), NOW).score;
    expect(close).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(occasional);
  });

  it("decays recency with a one-week half-life", () => {
    const fresh = scoreCandidate(candidate({ itemId: "a", publishedAt: daysAgo(0) }), profile(), NOW);
    const week = scoreCandidate(candidate({ itemId: "b", publishedAt: daysAgo(7) }), profile(), NOW);
    expect(fresh.signals.find((s) => s.kind === "recency")!.weight).toBeCloseTo(1);
    expect(week.signals.find((s) => s.kind === "recency")!.weight).toBeCloseTo(0.5);
  });

  it("penalizes disliked topics, distrusted publishers, too-basic and too-long pieces", () => {
    const p = profile({
      reviews: [
        { vote: "not_interested", reasons: ["not_my_topic"], tags: ["crypto"], title: null, publisherId: "x", authorKey: null },
        { vote: "not_interested", reasons: ["too_promotional"], tags: [], title: null, publisherId: "pub-spam", authorKey: null },
        { vote: "not_interested", reasons: ["too_basic", "too_long"], tags: [], title: null, publisherId: "y", authorKey: null },
      ],
    });
    const base = scoreCandidate(candidate({ itemId: "base" }), p, NOW).score;
    expect(scoreCandidate(candidate({ itemId: "a", title: "Crypto tokens explained" }), p, NOW).score).toBeLessThan(base);
    expect(scoreCandidate(candidate({ itemId: "spam", publisherId: "pub-spam" }), p, NOW).score).toBeLessThan(base);
    expect(scoreCandidate(candidate({ itemId: "b", depth: "introductory" }), p, NOW).score).toBeCloseTo(base - 1);
    expect(scoreCandidate(candidate({ itemId: "c", minutes: 30 }), p, NOW).score).toBeCloseTo(base - 1);
  });

  it("rewards topics and creators the user liked", () => {
    const p = profile({
      reviews: [{ vote: "interested", reasons: ["creator", "numbers"], tags: ["pricing"], title: null, publisherId: "p1", authorKey: "site:priya" }],
    });
    const s = scoreCandidate(candidate({ itemId: "a", title: "Pricing in public", authorKey: "site:priya" }), p, NOW);
    expect(s.signals.map((x) => x.kind)).toEqual(expect.arrayContaining(["liked_topic", "liked_creator"]));
  });

  it("treats negative (learned) topic weights as penalties", () => {
    const p = profile({ topics: [{ topic: "fundraising", weight: -0.5 }] });
    const s = scoreCandidate(candidate({ itemId: "a", title: "Fundraising in a downturn" }), p, NOW);
    expect(s.signals).toContainEqual({ kind: "disliked_topic", weight: -1.5, detail: "fundraising" });
  });

  it("falls back to the item's own tag as its topic", () => {
    expect(scoreCandidate(candidate({ itemId: "a", tags: ["cold email"] }), profile(), NOW).topic).toBe("Cold email");
    expect(scoreCandidate(candidate({ itemId: "b", kind: "video" }), profile(), NOW).topic).toBe("Video");
  });
});

describe("rankCandidates", () => {
  const p = profile({ topics: [{ topic: "pricing", weight: 1 }, { topic: "hiring", weight: 1 }] });

  it("takes at most one piece per publisher", () => {
    const c = [
      candidate({ itemId: "a1", publisherId: "A", title: "Pricing one" }),
      candidate({ itemId: "a2", publisherId: "A", title: "Pricing two" }),
      candidate({ itemId: "b1", publisherId: "B", title: "Something else" }),
    ];
    const { picks, reserve } = rankCandidates(c, p, { now: NOW, count: 3 });
    expect(picks.map((x) => x.itemId).sort()).toEqual(["a1", "b1"]);
    expect(reserve.map((x) => x.itemId)).toEqual(["a2"]);
  });

  it("prefers topic diversity while there's a choice", () => {
    const c = [
      candidate({ itemId: "p1", title: "Pricing your product", publishedAt: daysAgo(0) }),
      candidate({ itemId: "p2", title: "Pricing pages that work", publishedAt: daysAgo(0) }),
      candidate({ itemId: "h1", title: "Hiring your first engineer", publishedAt: daysAgo(3) }),
    ];
    const { picks } = rankCandidates(c, p, { now: NOW, count: 2 });
    expect(picks.map((x) => x.topic).sort()).toEqual(["Hiring", "Pricing"]);
  });

  it("fills with repeated topics when diversity runs out", () => {
    const c = [candidate({ itemId: "p1", title: "Pricing A" }), candidate({ itemId: "p2", title: "Pricing B" })];
    expect(rankCandidates(c, p, { now: NOW, count: 3 }).picks).toHaveLength(2);
  });

  it("is deterministic on ties and returns picks best first", () => {
    const c = ["c", "a", "b"].map((id) => candidate({ itemId: id }));
    const one = rankCandidates(c, profile(), { now: NOW }).picks.map((x) => x.itemId);
    const two = rankCandidates([...c].reverse(), profile(), { now: NOW }).picks.map((x) => x.itemId);
    expect(one).toEqual(["a", "b", "c"]);
    expect(two).toEqual(one);
  });

  it("finds a substitute that keeps publishers distinct", () => {
    const reserve = [
      { itemId: "r1", score: 3, topic: "X", publisherId: "A", signals: [] },
      { itemId: "r2", score: 2, topic: "Y", publisherId: "B", signals: [] },
    ];
    expect(nextSubstitute(reserve, [{ publisherId: "A" }], new Set())?.itemId).toBe("r2");
    expect(nextSubstitute(reserve, [{ publisherId: "A" }], new Set(["r2"]))).toBeNull();
  });
});

// ── Feedback codes ──────────────────────────────────────────────────────────

describe("feedback codes", () => {
  it("reads publication initials", () => {
    expect(publicationInitials("Membership Economics")).toEqual(["ME"]);
    expect(publicationInitials("Stripe Press")).toEqual(["SP", "ST"]);
    expect(publicationInitials("The Stratechery")).toEqual(["ST"]);
    expect(publicationInitials("")).toEqual([]);
  });

  it("follows the pattern, skips O/0/I/1, and is unique within a letter", () => {
    for (let seed = 1; seed < 200; seed++) {
      const codes = assignFeedbackCodes(["A", "B", "C", "D", "E", "F"], seeded(seed));
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(code).toMatch(/^[A-Z]{2}[0-9]{2}$/);
        expect(code).toMatch(FEEDBACK_CODE_PATTERN);
        expect(code).not.toMatch(/[OI01]/);
      }
    }
  });

  it("never starts a code with the piece's publication initials", () => {
    // A generator stuck on "M","E" would produce ME; it must keep drawing.
    const sequence = [0.45, 0.17, 0.45, 0.17, 0.0, 0.0, 0.5, 0.5];
    let i = 0;
    const rng = () => sequence[i++ % sequence.length]!;
    const [code] = assignFeedbackCodes(["Membership Economics"], rng);
    expect(code!.slice(0, 2)).not.toBe("ME");
  });

  it("redraws on a collision", () => {
    // The first two draws are identical; the second code must differ.
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0.9, 0.9, 0.9];
    let i = 0;
    const codes = assignFeedbackCodes(["X", "Y"], () => values[i++] ?? 0.5);
    expect(codes[0]).not.toBe(codes[1]);
  });
});

// ── Activity ────────────────────────────────────────────────────────────────

describe("activity", () => {
  const ev = (type: ActivityEvent["type"], itemId: string, at: string, localDay = at.slice(0, 10)): ActivityEvent => ({
    type,
    itemId,
    occurredAt: new Date(at),
    localDay,
  });

  it("buckets distinct items into four levels", () => {
    expect([0, 1, 2, 3, 4, 9].map(activityLevel)).toEqual([0, 1, 2, 2, 3, 3]);
  });

  it("counts open + complete, not a plain open", () => {
    const month = activityMonth(
      "2026-10",
      [ev("open", "a", "2026-10-02T08:00:00Z"), ev("complete", "a", "2026-10-02T08:10:00Z"), ev("open", "b", "2026-10-02T09:00:00Z")],
      [],
    );
    expect(month.days[1]).toEqual({ day: "2026-10-02", level: 1, read: 1, reviewed: 0 });
    expect(month.activeDays).toBe(1);
    expect(month.days).toHaveLength(31);
  });

  it("needs an open before the completion", () => {
    const month = activityMonth("2026-10", [ev("complete", "a", "2026-10-02T08:10:00Z"), ev("open", "a", "2026-10-02T09:00:00Z")], []);
    expect(month.activeDays).toBe(0);
  });

  it("lets uncomplete cancel an accidental completion", () => {
    const month = activityMonth(
      "2026-10",
      [ev("open", "a", "2026-10-03T08:00:00Z"), ev("complete", "a", "2026-10-03T08:01:00Z"), ev("uncomplete", "a", "2026-10-03T08:02:00Z")],
      [],
    );
    expect(month.activeDays).toBe(0);
  });

  it("counts reviews, and an item read and reviewed the same day once", () => {
    const month = activityMonth(
      "2026-10",
      [ev("open", "a", "2026-10-05T08:00:00Z"), ev("complete", "a", "2026-10-05T08:10:00Z")],
      [
        { itemId: "a", localDay: "2026-10-05" },
        { itemId: "b", localDay: "2026-10-05" },
      ],
    );
    expect(month.days[4]).toEqual({ day: "2026-10-05", level: 2, read: 1, reviewed: 2 });
  });

  it("uses the device's local day, never the UTC date", () => {
    // 23:30 in New York on Oct 6 is Oct 7 in UTC.
    const month = activityMonth(
      "2026-10",
      [ev("open", "a", "2026-10-07T03:20:00Z", "2026-10-06"), ev("complete", "a", "2026-10-07T03:30:00Z", "2026-10-06")],
      [],
    );
    expect(month.days[5]!.level).toBe(1);
    expect(month.days[6]!.level).toBe(0);
  });

  it("ignores other months and handles February", () => {
    const feb = activityMonth("2027-02", [ev("open", "a", "2027-03-01T08:00:00Z"), ev("complete", "a", "2027-03-01T08:10:00Z")], []);
    expect(feb.days).toHaveLength(28);
    expect(feb.activeDays).toBe(0);
  });
});

// ── Copy checks ─────────────────────────────────────────────────────────────

const piece = (over: Partial<WriterPiece> = {}): WriterPiece => ({
  ref: "11111111-aaaa",
  kind: "article",
  title: "How we priced our first B2B contract",
  sourceName: "A founder's blog",
  author: null,
  minutes: 9,
  topic: "Pricing",
  passages: [
    { id: "11111111.p1", text: "We charged $1,200 a month for the first clinic, which was 40% less than we wanted." },
    { id: "11111111.p2", text: "The spreadsheet had three columns: cost, value and what the buyer could approve alone." },
  ],
  allowedTags: ["New source"],
  signals: [{ kind: "lately", detail: "how to price a first contract" }],
  ...over,
});

describe("passages", () => {
  it("keeps the opening and the paragraphs about the brief, in reading order", () => {
    const paras = [
      "This opening paragraph sets out the argument of the whole piece clearly.",
      "Some filler about the weather and other things that are not relevant at all.",
      "More filler that rambles on about the author's commute to the office today.",
      "Our pricing changed after the third customer, when we moved to annual contracts.",
    ];
    const ps = selectPassages("abcdefgh-1234", paras, { focus: ["pricing"], max: 2 });
    expect(ps.map((p) => p.text)).toEqual([paras[0], paras[3]]);
    expect(ps.map((p) => p.id)).toEqual(["abcdefgh.p1", "abcdefgh.p2"]);
  });

  it("skips fragments and caps long paragraphs", () => {
    const long = `${"word ".repeat(400)}end.`;
    const ps = selectPassages("x", ["Too short.", long], { maxChars: 100 });
    expect(ps).toHaveLength(1);
    expect(ps[0]!.text.length).toBeLessThanOrEqual(101);
  });
});

describe("checkPieceCopy", () => {
  const brief = briefText({ role: "founder", lately: "how to price a first contract", topics: ["pricing"], leanings: [], facts: [] });
  const ok = { ref: "11111111-aaaa", whyPicked: "Because you said “how to price a first contract”.", summary: "They charged $1,200 a month, 40% under target.", tag: null, evidenceIds: ["11111111.p1"] };

  it("passes copy whose numbers and quotes come from its sources", () => {
    expect(checkPieceCopy(ok, piece(), brief)).toEqual([]);
  });

  it("finds numbers in their written forms", () => {
    expect(numbersIn("$1,200 a month, 40% and 2.5x in 2026; 5M ARR")).toEqual(["1200", "40", "2.5", "2026", "5"]);
    expect(quotesIn("He said “price it high” and 'ok'")).toEqual(["price it high"]);
  });

  it("rejects a number the cited passage doesn't contain", () => {
    expect(checkPieceCopy({ ...ok, summary: "They charged $1,500 a month." }, piece(), brief)).toContain("summary_number_unsupported:1500");
    // In the piece, but not in the passage it cites.
    expect(checkPieceCopy({ ...ok, summary: "Their sheet had 3 columns and $1,200.", evidenceIds: ["11111111.p1"] }, piece(), brief)).toContain(
      "summary_number_unsupported:3",
    );
  });

  it("rejects unknown or missing evidence", () => {
    expect(checkPieceCopy({ ...ok, evidenceIds: ["nope.p9"] }, piece(), brief)).toEqual(expect.arrayContaining(["unknown_evidence:nope.p9", "no_evidence"]));
  });

  it("rejects quotes that aren't the user's words or the piece's", () => {
    expect(checkPieceCopy({ ...ok, whyPicked: "Because you said “I hate spreadsheets”." }, piece(), brief)).toContain("why_quote_unsupported");
    expect(checkPieceCopy({ ...ok, summary: "They called it “the best decision we made” at $1,200." }, piece(), brief)).toContain("summary_quote_unsupported");
  });

  it("rejects tags the piece can't carry, links and over-long copy", () => {
    expect(checkPieceCopy({ ...ok, tag: "Via X" }, piece(), brief)).toContain("tag_not_allowed");
    expect(checkPieceCopy({ ...ok, tag: "New source" }, piece(), brief)).toEqual([]);
    expect(checkPieceCopy({ ...ok, summary: "See https://example.com for $1,200." }, piece(), brief)).toContain("contains_link");
    expect(checkPieceCopy({ ...ok, summary: "x".repeat(400) }, piece(), brief)).toContain("summary_too_long");
  });

  it("allows a null 'why I picked this'", () => {
    expect(checkPieceCopy({ ...ok, whyPicked: null }, piece(), brief)).toEqual([]);
  });
});

describe("checkLetterCopy", () => {
  const picks = [
    { title: "The fee is the product", passages: [{ id: "a.p1", text: "The store makes most of its profit from the $60 fee." }] },
    { title: "Ship it!", passages: [{ id: "b.p1", text: "Ship before you're ready." }] },
  ];
  const brief = "B2B SaaS founder\nMoving upmarket to enterprise";
  const headline = "Pricing, for a founder";

  it("keeps the headline to the letter's own numbers and the user's words", () => {
    expect(checkLetterCopy({ headline, intro: "Three things. 33 minutes in all." }, [3, 33], "")).toEqual([]);
    expect(checkLetterCopy({ headline: "Pricing", intro: "Five things. 50 minutes." }, [3, 33], "")).toContain("intro_number_unsupported:50");
    expect(checkLetterCopy({ headline: "", intro: "x" }, [], "")).toContain("headline_length");
    // A passage's number is fine in the intro, not in the headline.
    expect(checkLetterCopy({ headline: "The $60 fee", intro: "x" }, [], "", picks)).toContain("letter_number_unsupported:60");
    expect(checkLetterCopy({ headline: "“The fee is the product”", intro: "x" }, [], brief, picks)).toContain("letter_quote_unsupported");
  });

  it("passes a hook tying the user to what's in the picks", () => {
    const intro = "You're “moving upmarket to enterprise”, and “The fee is the product” shows a store living on a $60 fee. 33 minutes in all.";
    expect(checkLetterCopy({ headline, intro }, [2, 33], brief, picks)).toEqual([]);
  });

  it("allows numbers from the picks' titles and passages, quotes from the brief or a title", () => {
    expect(checkLetterCopy({ headline, intro: "A store that lives on a $75 fee." }, [2, 33], brief, picks)).toContain("intro_number_unsupported:75");
    expect(checkLetterCopy({ headline, intro: "Start with “Ten pricing myths”." }, [2, 33], brief, picks)).toContain("intro_quote_unsupported");
    // A quote from a passage isn't the user's words or a title.
    expect(checkLetterCopy({ headline, intro: "It says “ship before you're ready”." }, [2, 33], brief, picks)).toContain("intro_quote_unsupported");
  });

  it("rejects exclamation marks outside a title, links and over-long intros", () => {
    expect(checkLetterCopy({ headline, intro: "Start with “Ship it!” today." }, [], brief, picks)).toEqual([]);
    expect(checkLetterCopy({ headline, intro: "Start with this one!" }, [], brief, picks)).toContain("intro_exclamation");
    expect(checkLetterCopy({ headline, intro: "See www.example.com first." }, [], brief, picks)).toContain("contains_link");
    expect(checkLetterCopy({ headline, intro: "word ".repeat(45) }, [], brief, picks)).toContain("intro_length");
    expect(checkLetterCopy({ headline, intro: " " }, [], brief, picks)).toContain("intro_length");
  });
});

describe("checkPostscript", () => {
  const pieces = [
    { title: "The fee is the product", summary: "A membership store makes most of its profit from the $60 fee." },
    { title: "Hiring your first engineer", summary: "Hire someone who has shipped something on their own." },
  ];
  const ok = "Two today: “The fee is the product” on where a membership store's profit comes from, and “Hiring your first engineer” on hiring someone who has shipped.";

  it("passes a recap that names each piece and adds nothing", () => {
    expect(checkPostscript(ok, pieces)).toEqual([]);
    expect(checkPostscript("“The fee is the product” says the $60 fee carries the profit. “Hiring your first engineer” is about shipping.", pieces)).toEqual([]);
  });

  it("names only the letter's pieces, each of them unless told otherwise", () => {
    expect(checkPostscript(`${ok} Also see “Ten pricing myths”.`, pieces)).toContain("postscript_names_other_piece");
    const one = "You liked “The fee is the product” for the numbers.";
    expect(checkPostscript(one, pieces)).toEqual(["postscript_missing_piece"]);
    expect(checkPostscript(one, pieces, { requireEach: false })).toEqual([]);
  });

  it("keeps to the length cap, with no new numbers, exclamation marks or links", () => {
    expect(checkPostscript(`${ok} ${"More words here. ".repeat(20)}`, pieces)).toContain("postscript_length");
    expect(checkPostscript("", pieces)).toContain("postscript_length");
    expect(checkPostscript(`${ok} It made $90 a year.`, pieces)).toContain("postscript_number_unsupported:90");
    expect(checkPostscript(`${ok} Enjoy!`, pieces)).toContain("postscript_exclamation");
    expect(checkPostscript(`${ok} See https://example.com`, pieces)).toContain("contains_link");
    // A title's own "!" is fine.
    expect(checkPostscript("Just “Ship it!” today.", [{ title: "Ship it!", summary: "Ship." }])).toEqual([]);
  });

  it("writes a default from the titles that passes its own checks", () => {
    expect(fallbackPostscript([])).toBeNull();
    expect(fallbackPostscript(["The fee is the product"])).toBe("Today was “The fee is the product”. Tell me if it was worth your time.");
    const three = fallbackPostscript(["A long title", "Another title", "A 3rd title"])!;
    expect(three).toBe("Today was “A long title”, “Another title” and “A 3rd title”. Tell me which were worth your time.");
    expect(checkPostscript(three, ["A long title", "Another title", "A 3rd title"].map((title) => ({ title, summary: "" })))).toEqual([]);
  });
});

describe("fallback copy", () => {
  it("summarizes with the piece's own first sentences, which always verify", () => {
    const p = piece();
    const copy = fallbackLetterCopy({ brief: { role: "Founder", lately: null, topics: [], leanings: [], facts: [] }, pieces: [p], pickCount: 1 });
    expect(copy.pieces[0]!.summary).toBe(p.passages[0]!.text);
    expect(checkPieceCopy(copy.pieces[0]!, p, briefText({ role: null, lately: "how to price a first contract", topics: [], leanings: [], facts: [] }))).toEqual([]);
    expect(copy.headline).toBe("Pricing, for a founder");
    expect(copy.intro).toBe("For a founder: just one today, “How we priced our first B2B contract”. 9 minutes in all.");
    expect(checkLetterCopy(copy, [1, 9], "Founder", [p])).toEqual([]);
    expect(copy.postscript).toBe("Today was “How we priced our first B2B contract”. Tell me if it was worth your time.");
  });

  it("takes at most two sentences", () => {
    expect(leadSentences("One. Two! Three? Four.")).toBe("One. Two!");
  });

  it("writes 'why I picked this' only from the user's words or topics", () => {
    expect(fallbackWhyPicked([{ kind: "lately", detail: "costco" }])).toBe("Because you said you're into “costco”.");
    expect(fallbackWhyPicked([{ kind: "topic", detail: "Pricing" }])).toBe("It's about pricing, one of your topics.");
    expect(fallbackWhyPicked([{ kind: "recency", detail: null }])).toBeNull();
  });

  it("writes headlines", () => {
    expect(fallbackHeadline(["Pricing", "Hiring", "Pricing"], null)).toBe("Pricing and hiring, picked for you");
  });

  describe("intro", () => {
    const pick = (title: string, topic: string, minutes: number, signals: { kind: string; detail: string | null }[] = []) => ({ title, topic, minutes, signals });
    const none: WriterBrief = { role: null, lately: null, topics: [], leanings: [], facts: [] };
    const picks = [
      pick("Hiring your first engineer", "Hiring", 6),
      pick("Price the outcome", "Pricing", 8, [{ kind: "lately", detail: "hourly billing" }]),
      pick("Cold email that works", "Sales", 4),
    ];

    it("leads with the pick tied to what they're into lately, in their words", () => {
      const brief = { ...none, role: "Solo consultant", lately: "Getting off hourly billing." };
      const intro = fallbackIntro(brief, picks);
      expect(intro).toBe("You said you're into “getting off hourly billing”: start with “Price the outcome”, then two more on hiring and sales. 18 minutes in all.");
      expect(checkLetterCopy({ headline: "x", intro }, [3, 18], briefText(brief), picks.map((p) => ({ title: p.title, passages: [] })))).toEqual([]);
    });

    it("uses a chosen leaning, then the role, then nothing", () => {
      const leaning = [pick("A", "Pricing", 5), pick("B", "Sales", 5, [{ kind: "leaning", detail: "More on sales" }])];
      expect(fallbackIntro({ ...none, leanings: ["More on sales"] }, leaning)).toBe("You asked for “more on sales”: start with “B”, then one more on pricing. 10 minutes in all.");
      // A lately that no pick is tied to isn't claimed.
      expect(fallbackIntro({ ...none, role: "Indie hacker", lately: "Something else" }, picks.slice(0, 1))).toBe("For an indie hacker: just one today, “Hiring your first engineer”. 6 minutes in all.");
      expect(fallbackIntro({ ...none, role: "B2B SaaS founder" }, [pick("Why?", "AI evals", 3)])).toBe("For a B2B SaaS founder: just one today, “Why?” 3 minutes in all.");
      expect(fallbackIntro(none, [picks[0]!, picks[2]!, pick("Seed rounds", "Fundraising", 1)])).toBe("Start with “Hiring your first engineer”, then two more on sales and fundraising. 11 minutes in all.");
    });

    it("drops the topics, then the hook, to stay within the cap", () => {
      const many = ["Pricing", "Sales", "Hiring", "SEO"].map((t, i) => pick(`Piece ${i}`, t, 2));
      expect(fallbackIntro(none, many)).toBe("Start with “Piece 0”, then three more. 8 minutes in all.");
      const long = "a very long title that goes on ".repeat(3).trim();
      const intro = fallbackIntro({ ...none, role: "founder", lately: "x ".repeat(40) }, [pick(long, "Pricing", 5, [{ kind: "lately", detail: "x" }]), pick("B", "Sales", 5)]);
      expect(intro).toBe(`For a founder: start with “${long}”, then one more on sales. 10 minutes in all.`);
      expect(intro.length).toBeLessThanOrEqual(COPY_LIMITS.intro);
      expect(fallbackIntro(none, [pick("t".repeat(200), "Pricing", 5)])).toBe("One thing I picked for you. 5 minutes in all.");
      expect(countIntro(3, 33)).toBe("Three things I picked for you. 33 minutes in all.");
    });
  });
});

// ── Chapters ────────────────────────────────────────────────────────────────

describe("splitChapters", () => {
  const seg = (sec: number, text: string) => ({ text, offsetMs: sec * 1000, durationMs: 5000 });

  it("cuts a long transcript into 4–8 chapters at caption boundaries", () => {
    const segments = Array.from({ length: 300 }, (_, i) => seg(i * 6, `Point ${i} is here.`));
    const chapters = splitChapters(segments);
    expect(chapters.length).toBeGreaterThanOrEqual(4);
    expect(chapters.length).toBeLessThanOrEqual(8);
    expect(chapters[0]!.startSeconds).toBe(0);
    for (let i = 1; i < chapters.length; i++) expect(chapters[i]!.startSeconds).toBeGreaterThan(chapters[i - 1]!.startSeconds);
    expect(chapters.map((c) => c.text).join(" ")).toBe(segments.map((s) => s.text).join(" "));
  });

  it("keeps at least four chapters for a short video when there are enough captions", () => {
    expect(splitChapters(Array.from({ length: 10 }, (_, i) => seg(i * 10, `Line ${i}.`)))).toHaveLength(4);
    expect(splitChapters([seg(0, "Only one.")])).toHaveLength(1);
    expect(splitChapters([])).toEqual([]);
  });

  it("titles chapters with their own opening words", () => {
    expect(chapterTitle("so where do you look for your first engineer? Open source.")).toBe("Where do you look for your first engineer");
    expect(chapterTitle("a".repeat(10) + " " + "b".repeat(60)).endsWith("…")).toBe(true);
  });
});

// ── P.S. ────────────────────────────────────────────────────────────────────

describe("postscript", () => {
  it("offers about four short leanings from feedback and topics, ending with something new", () => {
    const options = leaningOptions({
      topics: ["pricing", "sales", "hiring"],
      feedback: [{ vote: "interested", reasons: ["numbers", "concise"], topic: "Pricing" }],
      letterTopics: ["Pricing"],
    });
    expect(options).toEqual(["Pricing, with numbers", "Pieces with real numbers", "Short reads", "Something new"]);
    for (const o of options) expect(o.length).toBeLessThanOrEqual(LEANING_MAX_CHARS);
  });

  it("falls back to topics not in today's letter", () => {
    expect(leaningOptions({ topics: ["pricing", "sales"], feedback: [], letterTopics: ["pricing"] })).toEqual([
      "More on sales",
      "More on pricing",
      "Short reads",
      "Something new",
    ]);
    expect(leaningOptions({ topics: [], feedback: [], letterTopics: [] })).toEqual(["Short reads", "Something new"]);
  });

  it("signs verdicts independent of order", () => {
    const a = { itemId: "a", vote: "interested" as const, reasons: ["numbers", "topic"] };
    const b = { itemId: "b", vote: "not_interested" as const, reasons: [] };
    expect(verdictSignature([a, b])).toBe(verdictSignature([b, { ...a, reasons: ["topic", "numbers"] }]));
    expect(verdictSignature([a])).not.toBe(verdictSignature([{ ...a, reasons: [] }]));
  });

  it("writes a recap from what was worth it and what wasn't", () => {
    const yes = (title: string, reasons: string[] = []) => ({ title, vote: "interested" as const, reasons });
    const no = (title: string, reasons: string[] = []) => ({ title, vote: "not_interested" as const, reasons });
    expect(fallbackRecap([])).toBeNull();
    expect(fallbackRecap([{ title: "Unread", vote: null, reasons: [] }])).toBeNull();
    expect(fallbackRecap([yes("The fee is the product", ["numbers"])])).toBe("You marked “The fee is the product” worth it, for the numbers.");
    expect(fallbackRecap([yes("A"), yes("B"), yes("C")])).toBe("You marked 3 pieces worth it, including “A”.");
    expect(fallbackRecap([no("Growth hacks", ["too_basic", "too_long"])])).toBe("“Growth hacks” wasn't for you: too basic and too long.");
    expect(fallbackRecap([yes("A", ["practical"]), no("B"), no("C", ["already_knew"]), { title: "D", vote: null, reasons: [] }])).toBe(
      "You marked “A” worth it, for how practical it was. “B” and “C” weren't for you: nothing new to you.",
    );
  });

  it("signs no feedback as empty, and changes with a dislike's reasons", () => {
    expect(verdictSignature([])).toBe("");
    const b = { itemId: "b", vote: "not_interested" as const, reasons: ["too_basic"] };
    expect(verdictSignature([b])).not.toBe(verdictSignature([{ ...b, reasons: ["too_long"] }]));
  });

  it("names a change in the mix after reasoned dislikes and chosen leanings", () => {
    const line = whyThisMix({
      feedback: [{ vote: "not_interested", reasons: ["too_basic"], topic: "Growth", publisherName: "X", at: new Date("2026-10-12T10:00:00Z") }],
      chosenLeanings: ["Short reads"],
    });
    expect(line).toBe("Fewer beginner-level pieces, per your feedback on 12 Oct. More of “Short reads”, as you asked.");
    expect(whyThisMix({ feedback: [], chosenLeanings: [] })).toBeNull();
    expect(
      whyThisMix({ feedback: [{ vote: "interested", reasons: ["numbers"], topic: null, publisherName: "X", at: NOW }], chosenLeanings: [] }),
    ).toBeNull();
  });
});

// ── Authors ─────────────────────────────────────────────────────────────────

describe("authors", () => {
  it("cleans bylines", () => {
    expect(cleanAuthorName("By Priya Raman")).toBe("Priya Raman");
    expect(cleanAuthorName("Priya Raman and Dana Whitfield")).toBe("Priya Raman");
    expect(cleanAuthorName("https://example.com/about")).toBeNull();
    expect(cleanAuthorName("Membership Economics", "Membership Economics")).toBeNull();
    expect(cleanAuthorName("admin")).toBeNull();
    expect(cleanAuthorName(null)).toBeNull();
  });

  it("keys bylines by publisher and channels by channel", () => {
    expect(authorKeyFor({ name: "Priya Raman", publisherKey: "priyaraman.com" })).toBe("priyaraman.com:priya-raman");
    expect(authorKeyFor({ name: "Founders Talk", publisherKey: "youtube:UC123" })).toBe("youtube:UC123");
    expect(authorKeyFor({ name: "Zoë Ångström", publisherKey: "x.com" })).toBe("x.com:zoe-angstrom");
  });

  it("writes initials and provenance", () => {
    expect(initialsFor("Priya Raman")).toBe("PR");
    expect(initialsFor("Marcus Hale Jr")).toBe("MH");
    expect(initialsFor("a16z")).toBe("A");
    expect(provenanceLine([{ name: "priyaraman.com" }, { name: "Crunchbase" }], new Date("2026-10-03T10:00:00Z"))).toBe(
      "From priyaraman.com and Crunchbase, checked Oct 3",
    );
    expect(provenanceLine([], NOW)).toBeNull();
  });

  it("re-checks details after about 90 days", () => {
    expect(authorNeedsCheck(null, NOW)).toBe(true);
    expect(authorNeedsCheck(daysAgo(30), NOW)).toBe(false);
    expect(authorNeedsCheck(daysAgo(91), NOW)).toBe(true);
  });
});
