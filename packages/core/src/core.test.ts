import { describe, expect, it } from "vitest";
import { FEED_POLL_INTERVAL_MS, MAX_CONSECUTIVE_FAILURES, nextFetch } from "./fetch-schedule.ts";
import { countWords, readTimeMinutes } from "./reading.ts";
import { decideItemAccess, PERSONAL_USE_DEFAULT, type RightsRuleInput, resolveRights } from "./rights.ts";

const excerptRule = (scope: "domain" | "source", scopeKey: string): RightsRuleInput => ({
  scope,
  scopeKey,
  display: "excerpt_only",
  retainText: true,
  offlineAllowed: false,
  licenseNote: "digest only",
});

describe("resolveRights", () => {
  it("defaults to personal-use full text", () => {
    expect(resolveRights([], { publisherKey: "example.com" })).toEqual(PERSONAL_USE_DEFAULT);
  });

  it("applies a domain rule", () => {
    const rights = resolveRights([excerptRule("domain", "example.com")], { publisherKey: "example.com" });
    expect(rights).toMatchObject({ display: "excerpt_only", offlineAllowed: false, licenseNote: "digest only" });
  });

  it("prefers a source rule over a domain rule", () => {
    const rules: RightsRuleInput[] = [
      excerptRule("domain", "example.com"),
      { scope: "source", scopeKey: "https://example.com/feed", display: "link_only", retainText: false, offlineAllowed: true },
    ];
    const rights = resolveRights(rules, { publisherKey: "example.com", sourceKey: "https://example.com/feed" });
    expect(rights.display).toBe("link_only");
    // Offline needs retained text.
    expect(rights.offlineAllowed).toBe(false);
  });

  it("ignores rules for other publishers", () => {
    expect(resolveRights([excerptRule("domain", "other.com")], { publisherKey: "example.com" }).display).toBe("full_text");
  });
});

describe("decideItemAccess", () => {
  it("stores full text offline by default", () => {
    expect(decideItemAccess(PERSONAL_USE_DEFAULT, { unavailableReason: null })).toEqual({
      display: "full_text",
      storeBlocks: true,
      offlineAllowed: true,
      digest: false,
      unavailableReason: null,
    });
  });

  it("makes a paywalled item metadata-only", () => {
    const access = decideItemAccess(PERSONAL_USE_DEFAULT, { unavailableReason: "paywalled" });
    expect(access).toMatchObject({ display: "link_only", storeBlocks: false, offlineAllowed: false });
    expect(access.unavailableReason).toBe("paywalled");
  });

  it("labels excerpt-only items as a digest", () => {
    const access = decideItemAccess(
      { display: "excerpt_only", retainText: true, offlineAllowed: true },
      { unavailableReason: null },
    );
    expect(access).toMatchObject({ digest: true, storeBlocks: true, offlineAllowed: true });
  });

  it("never stores or caches link-only items", () => {
    const access = decideItemAccess({ display: "link_only", retainText: true, offlineAllowed: true }, { unavailableReason: null });
    expect(access).toMatchObject({ storeBlocks: false, offlineAllowed: false });
  });

  it("doesn't store text the rule says not to retain", () => {
    const access = decideItemAccess({ display: "full_text", retainText: false, offlineAllowed: true }, { unavailableReason: null });
    expect(access).toMatchObject({ storeBlocks: false, offlineAllowed: false });
  });
});

describe("nextFetch", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it("polls feeds hourly after a success and resets failures", () => {
    expect(nextFetch(now, { ok: true, oneShot: false, previousFailures: 3 })).toEqual({
      nextFetchAt: new Date(now.getTime() + FEED_POLL_INTERVAL_MS),
      consecutiveFailures: 0,
    });
  });

  it("doesn't reschedule one-shot URLs", () => {
    expect(nextFetch(now, { ok: true, oneShot: true, previousFailures: 0 }).nextFetchAt).toBeNull();
  });

  it("backs off exponentially and caps at a day", () => {
    const delays = [0, 1, 2, 7, 8].map((previousFailures) => {
      const next = nextFetch(now, { ok: false, oneShot: false, previousFailures });
      return (next.nextFetchAt!.getTime() - now.getTime()) / 60_000;
    });
    expect(delays).toEqual([15, 30, 60, 1440, 1440]);
  });

  it("gives up after too many failures", () => {
    const next = nextFetch(now, { ok: false, oneShot: false, previousFailures: MAX_CONSECUTIVE_FAILURES - 1 });
    expect(next).toEqual({ nextFetchAt: null, consecutiveFailures: MAX_CONSECUTIVE_FAILURES });
  });
});

describe("reading", () => {
  it("counts words across scripts and contractions", () => {
    expect(countWords("It’s a well-known fact — 42 founders, café owners.")).toBe(8);
    expect(countWords("   ")).toBe(0);
  });

  it("rounds read time up with a floor of one minute", () => {
    expect(readTimeMinutes(0)).toBe(1);
    expect(readTimeMinutes(231)).toBe(2);
  });
});
