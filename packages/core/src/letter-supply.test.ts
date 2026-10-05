import { describe, expect, it } from "vitest";
import {
  briefFit,
  candidateTarget,
  type CollectionStep,
  MIN_PIECES,
  nextCollectionStep,
  piecesWanted,
  RANKED_RESERVE,
  RESERVE_DEPTH,
  SHARED_POOL_MIN_FIT,
  sharedPoolMatches,
  shortReason,
} from "./letter-supply.ts";
import type { RankCandidate } from "./ranking.ts";

const NOW = new Date("2026-10-05T12:00:00Z");

const pool = (over: Partial<RankCandidate> & { itemId: string }): RankCandidate => ({
  kind: "article",
  title: "Untitled",
  tags: [],
  excerpt: null,
  publisherId: `pub-${over.itemId}`,
  publisherName: `Publisher ${over.itemId}`,
  authorKey: null,
  sourceMode: null,
  publishedAt: new Date("2026-10-01T00:00:00Z"),
  quality: null,
  depth: null,
  minutes: 6,
  shared: true,
  ...over,
});

describe("piecesWanted", () => {
  it("is the schedule's count, never below the minimum of three", () => {
    expect(MIN_PIECES).toBe(3);
    expect(piecesWanted(undefined)).toBe(3);
    expect(piecesWanted(null)).toBe(3);
    expect(piecesWanted(1)).toBe(3);
    expect(piecesWanted(2)).toBe(3);
    expect(piecesWanted(5)).toBe(5);
  });

  it("aims for spare candidates, and ranks a reserve at least that deep", () => {
    expect(candidateTarget(3)).toBe(3 + RESERVE_DEPTH);
    expect(RANKED_RESERVE).toBeGreaterThanOrEqual(RESERVE_DEPTH);
  });
});

describe("nextCollectionStep", () => {
  const run = (found: (step: CollectionStep) => number, discovery: "available" | "ran" | "off" = "available") => {
    const done: CollectionStep[] = [];
    let total = 0;
    for (;;) {
      const step = nextCollectionStep({ found: total, wanted: 3, done, discovery });
      if (!step) return done;
      done.push(step);
      if (step === "discovery") return done;
      total += found(step);
    }
  };

  it("stops after the user's own candidates when there are enough to spare", () => {
    expect(run(() => 7)).toEqual(["own"]);
  });

  it("widens, then uses the shared pool, while there's no reserve, without discovery once there are enough pieces", () => {
    expect(run((s) => (s === "own" ? 3 : 0))).toEqual(["own", "widened", "shared_pool"]);
    expect(run((s) => (s === "own" ? 2 : s === "widened" ? 5 : 0))).toEqual(["own", "widened"]);
  });

  it("runs discovery last, only when there still aren't enough for the pieces", () => {
    expect(run((s) => (s === "own" ? 1 : s === "widened" ? 0 : 1))).toEqual(["own", "widened", "shared_pool", "discovery"]);
  });

  it("doesn't run discovery twice for a letter, or when it's off", () => {
    expect(run(() => 0, "ran")).toEqual(["own", "widened", "shared_pool"]);
    expect(run(() => 0, "off")).toEqual(["own", "widened", "shared_pool"]);
  });

  it("asks for more than the minimum when the schedule wants more pieces", () => {
    expect(nextCollectionStep({ found: 4, wanted: 5, done: ["own", "widened", "shared_pool"], discovery: "available" })).toBe("discovery");
    expect(nextCollectionStep({ found: 5, wanted: 5, done: ["own", "widened", "shared_pool"], discovery: "available" })).toBeNull();
  });
});

describe("the shared pool", () => {
  const brief = { topics: [{ topic: "pricing", weight: 1 }, { topic: "hiring", weight: 0.2 }], lately: "moving upmarket to enterprise", leanings: [] };

  it("matches items to the brief's topics and 'lately', not to anything else", () => {
    expect(briefFit(pool({ itemId: "a", title: "Pricing your first contract" }), brief, NOW)).toBe(3);
    expect(briefFit(pool({ itemId: "b", title: "Moving upmarket to enterprise customers" }), brief, NOW)).toBeGreaterThanOrEqual(2);
    // A weak (learned) topic alone isn't enough.
    expect(briefFit(pool({ itemId: "c", title: "Hiring your first engineer" }), brief, NOW)).toBeLessThan(SHARED_POOL_MIN_FIT);
    expect(briefFit(pool({ itemId: "d", title: "Gardening in autumn", quality: "substantive" }), brief, NOW)).toBe(0);
  });

  it("keeps the matches, best first, then newest, at most `max`", () => {
    const items = [
      pool({ itemId: "garden", title: "Gardening in autumn" }),
      pool({ itemId: "old", title: "Pricing pages", publishedAt: new Date("2026-08-01T00:00:00Z") }),
      pool({ itemId: "new", title: "Pricing pages", publishedAt: new Date("2026-10-04T00:00:00Z") }),
      pool({ itemId: "both", title: "Pricing when moving upmarket to enterprise" }),
    ];
    expect(sharedPoolMatches(items, brief, { now: NOW }).map((c) => c.itemId)).toEqual(["both", "new", "old"]);
    expect(sharedPoolMatches(items, brief, { now: NOW, max: 1 }).map((c) => c.itemId)).toEqual(["both"]);
  });
});

describe("shortReason", () => {
  it("says what was tried and what ran out", () => {
    expect(shortReason({ wanted: 3, pieces: 2, candidates: 2, discovery: "ran" })).toBe(
      "2 of 3 pieces: 2 usable candidates after own sources, a 180-day window and the shared pool; discovery already ran for this letter",
    );
    expect(shortReason({ wanted: 3, pieces: 0, candidates: 0, discovery: "off" })).toContain("discovery is off");
    expect(shortReason({ wanted: 3, pieces: 2, candidates: 5, discovery: "available", rejected: 3 })).toContain(
      "3 failed verification and no substitute was left",
    );
  });
});
