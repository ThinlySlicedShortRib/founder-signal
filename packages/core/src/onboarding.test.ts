import { describe, expect, it } from "vitest";
import { fillsFor, formFromFacts, NO_FILLS, parseProfileNote, roleFromText, screenFacts, sensitiveCategory, topicsFromText } from "./onboarding.ts";
import { nextRunAt, zonedTimeToUtc } from "./schedule.ts";

const NOTE = `1. Work: Founder of a two-person B2B SaaS startup.
2. Building now: A scheduling tool for clinics; chasing the first ten paying customers.
3. Curious about: Usage-based pricing; how Supabase grew as an open-source company.
4. Recurring questions: Pricing tiers, cold outreach, hiring a first engineer.
5. Sources: Lenny's Newsletter, Stratechery.
(Also mentioned a recent back injury.)`;

describe("parseProfileNote", () => {
  const result = parseProfileNote(NOTE);

  it("turns each heading into facts, one per item", () => {
    expect(result.facts.map((f) => [f.kind, f.text])).toEqual([
      ["work", "Founder of a two-person B2B SaaS startup"],
      ["building", "A scheduling tool for clinics"],
      ["building", "chasing the first ten paying customers"],
      ["curious", "Usage-based pricing"],
      ["curious", "how Supabase grew as an open-source company"],
      ["recurring", "Pricing tiers, cold outreach, hiring a first engineer"],
      ["source", "Lenny's Newsletter, Stratechery"],
    ]);
  });

  it("drops the personal aside and reports only its category", () => {
    expect(result.dropped).toEqual([{ category: "health" }]);
    expect(JSON.stringify(result.facts)).not.toMatch(/injury/);
  });

  it("says what each line fills in the form", () => {
    expect(result.facts[0]!.fills).toMatchObject({ role: "founder" });
    expect(result.facts[1]!.fills).toMatchObject({ lately: "A scheduling tool for clinics" });
    expect(result.facts.find((f) => f.text.startsWith("chasing"))!.fills.topics).toEqual(["first customers"]);
    expect(result.facts.find((f) => f.kind === "recurring")!.fills.topics).toEqual(["pricing", "sales", "hiring"]);
    expect(result.facts.find((f) => f.text.includes("Supabase"))!.fills.topics).toEqual(["open source", "developer tools"]);
    expect(result.facts.find((f) => f.kind === "source")!.fills.sources).toEqual([
      { name: "Lenny's Newsletter", url: null },
      { name: "Stratechery", url: null },
    ]);
  });

  it("fills the whole form from the kept lines", () => {
    expect(formFromFacts(result.facts)).toEqual({
      role: "founder",
      lately: "A scheduling tool for clinics",
      topics: ["first customers", "pricing", "open source", "developer tools", "sales", "hiring"],
      platforms: [],
      sources: [
        { name: "Lenny's Newsletter", url: null },
        { name: "Stratechery", url: null },
      ],
    });
    // Unticking the work line takes the role with it.
    expect(formFromFacts(result.facts.slice(1)).role).toBeNull();
  });

  it("treats facts without fills as filling nothing", () => {
    const old = [{ kind: "curious", text: "Usage-based pricing", topics: ["pricing"] }] as unknown as Parameters<typeof formFromFacts>[0];
    expect(formFromFacts(old)).toEqual({ role: null, lately: null, topics: [], platforms: [], sources: [] });
  });

  it("handles markdown bullets and bold headings", () => {
    const r = parseProfileNote("- **Work:** Consultant for SaaS companies\n- **Curious about:** AI agents");
    expect(r.facts.map((f) => f.kind)).toEqual(["work", "curious"]);
    expect(r.facts[0]!.fills.role).toBe("consultant");
    expect(r.facts[1]!.fills.topics).toEqual(["AI tools"]);
  });

  it("returns nothing for an assistant that knows nothing", () => {
    expect(parseProfileNote("I don't know much about you yet, so I can't write this.")).toEqual({ facts: [], dropped: [] });
  });

  it("ignores text before the first heading", () => {
    expect(parseProfileNote("Sure! Here's your profile:\n\nWork: Investor at a seed fund").facts).toHaveLength(1);
  });
});

describe("sensitiveCategory", () => {
  it.each([
    ["My API key is sk-123", "credentials"],
    ["Recovering from surgery", "health"],
    ["Paying off student loans", "finances"],
    ["Planning around my kids' school", "family"],
    ["Their roadmap is under NDA", "confidential"],
  ])("%s → %s", (text, category) => expect(sensitiveCategory(text)).toBe(category));

  it.each(["A scheduling tool for clinics", "Healthtech pricing", "Fundraising for a seed round", "Token-based pricing"])(
    "keeps work facts like %s",
    (text) => expect(sensitiveCategory(text)).toBeNull(),
  );
});

describe("screenFacts", () => {
  it("drops personal facts a model let through and fills in topics", () => {
    const r = screenFacts([
      { kind: "curious", text: "Open source business models", fills: NO_FILLS },
      { kind: "work", text: "Works around my therapy schedule", fills: NO_FILLS },
    ]);
    expect(r.facts).toEqual([
      { kind: "curious", text: "Open source business models", fills: { ...NO_FILLS, topics: ["business models", "pricing", "open source", "developer tools"] } },
    ]);
    expect(r.dropped).toEqual([{ category: "health" }]);
  });

  it("checks what a fact fills, not just its text", () => {
    const r = screenFacts([{ kind: "building", text: "A side project", fills: { ...NO_FILLS, lately: "Recovering from surgery" } }]);
    expect(r.facts).toEqual([]);
    expect(r.dropped).toEqual([{ category: "health" }]);
  });

  it("keeps the user's own topic wording", () => {
    const r = screenFacts([{ kind: "curious", text: "Vertical SaaS", fills: { ...NO_FILLS, topics: ["vertical SaaS"] } }]);
    expect(r.facts[0]!.fills.topics).toEqual(["vertical SaaS"]);
  });
});

describe("fillsFor", () => {
  it("reads platforms named among the sources", () => {
    expect(fillsFor("source", "Lenny's Newsletter on Substack, a few YouTube channels").platforms).toEqual(["substack", "youtube"]);
  });
});

describe("topicsFromText / roleFromText", () => {
  it("reads the lately answer", () => {
    expect(topicsFromText("How Costco makes its money on memberships, not groceries")).toEqual(["business models", "pricing"]);
    expect(topicsFromText("Gardening")).toEqual([]);
  });

  it("tells a founder-to-be from a founder", () => {
    expect(roleFromText("I want to start a company next year")).toBe("founder-to-be");
    expect(roleFromText("Co-founder and CEO")).toBe("founder");
    expect(roleFromText("Angel investor")).toBe("investor");
  });
});

describe("nextRunAt", () => {
  const weekdays = { weekdays: [1, 2, 3, 4, 5], localTime: "07:30" };

  it("is later today when the time hasn't passed", () => {
    // Wednesday 1 Oct 2026, 06:00 in London (BST, UTC+1).
    const now = new Date("2026-10-01T05:00:00Z");
    expect(nextRunAt({ ...weekdays, timeZone: "Europe/London" }, now)!.toISOString()).toBe("2026-10-01T06:30:00.000Z");
  });

  it("skips to the next chosen weekday", () => {
    // Friday 2 Oct 2026, 08:00 London → Monday.
    const now = new Date("2026-10-02T07:00:00Z");
    expect(nextRunAt({ ...weekdays, timeZone: "Europe/London" }, now)!.toISOString()).toBe("2026-10-05T06:30:00.000Z");
  });

  it("recurs a week later for a weekly slot that just passed", () => {
    // Sunday 4 Oct 2026, 09:00 exactly in New York (EDT).
    const now = new Date("2026-10-04T13:00:00Z");
    expect(nextRunAt({ weekdays: [0], localTime: "09:00", timeZone: "America/New_York" }, now)!.toISOString()).toBe("2026-10-11T13:00:00.000Z");
  });

  it("keeps the local time across the end of daylight saving", () => {
    // London leaves BST on Sunday 25 Oct 2026; Monday's 07:30 is then UTC+0.
    const now = new Date("2026-10-23T08:00:00Z");
    expect(nextRunAt({ ...weekdays, timeZone: "Europe/London" }, now)!.toISOString()).toBe("2026-10-26T07:30:00.000Z");
  });

  it("uses the local date, not the UTC date", () => {
    // 23:30 Sunday in Los Angeles is already Monday in UTC.
    const now = new Date("2026-10-05T06:30:00Z");
    expect(nextRunAt({ ...weekdays, timeZone: "America/Los_Angeles" }, now)!.toISOString()).toBe("2026-10-05T14:30:00.000Z");
  });

  it("returns null with no weekdays", () => {
    expect(nextRunAt({ weekdays: [], localTime: "07:30", timeZone: "UTC" }, new Date())).toBeNull();
  });
});

describe("zonedTimeToUtc", () => {
  it("moves a time skipped by clocks going forward past the gap", () => {
    // New York skips 02:00–03:00 on 8 Mar 2026.
    expect(zonedTimeToUtc(2026, 3, 8, 2, 30, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first of a repeated time when clocks go back", () => {
    // 01:30 happens twice in New York on 1 Nov 2026; the first is EDT (UTC-4).
    expect(zonedTimeToUtc(2026, 11, 1, 1, 30, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles half-hour zones", () => {
    expect(zonedTimeToUtc(2026, 10, 5, 7, 30, "Asia/Kolkata").toISOString()).toBe("2026-10-05T02:00:00.000Z");
  });
});
