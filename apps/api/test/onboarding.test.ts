import type { ProfileImporter } from "@fs/ai";
import { schema } from "@fs/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const NOTE = `1. Work: Founder of a two-person B2B SaaS startup.
2. Building now: A scheduling tool for clinics; chasing the first ten paying customers.
3. Curious about: Usage-based pricing.
(Also mentioned a recent back injury.)`;

const imports: { assistant: string; text: string }[] = [];
let importerFails = false;
const fills = (f: Record<string, unknown> = {}) => ({ role: null, lately: null, topics: [], platforms: [], sources: [], ...f });
const importer: ProfileImporter = {
  method: "anthropic",
  model: "test-model",
  promptVersion: "test-v1",
  async read(input) {
    imports.push(input);
    if (importerFails) throw new Error("overloaded");
    return {
      facts: [
        { kind: "work", text: "Founder of a two-person SaaS startup", fills: fills({ role: "founder" }) },
        { kind: "building", text: "A scheduling tool for clinics", fills: fills({ lately: "a scheduling tool for clinics", topics: ["clinic software"] }) },
        { kind: "curious", text: "Usage-based pricing", fills: fills({ topics: ["pricing"] }) },
        { kind: "source", text: "Lenny's Newsletter", fills: fills({ platforms: ["substack"], sources: [{ name: "Lenny's Newsletter", url: null }] }) },
        // Something the model should have left out: screened again on our side.
        { kind: "building", text: "Recovering from surgery while building", fills: fills() },
      ],
      dropped: [{ category: "health" }],
    };
  },
};

const ctx = createTestApp({ profileImporter: importer });
afterAll(() => ctx.pool.end());

let cookie: string;
let userId: string;
beforeAll(async () => {
  cookie = await signIn(ctx, "onboarding@example.com");
  const [u] = await ctx.db.select().from(schema.user).where(eq(schema.user.email, "onboarding@example.com"));
  userId = u!.id;
});

const call = (method: string, path: string, body?: unknown, as = cookie) =>
  ctx.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/me/preferences", () => {
  it("requires sign-in", async () => {
    expect((await ctx.app.request(`${BASE_URL}/me/preferences`)).status).toBe(401);
  });

  it("starts empty", async () => {
    const res = await call("GET", "/me/preferences");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profile: { role: null, lately: null, topics: [], platforms: [], imported: null, schedule: null, onboardedAt: null },
    });
  });

  it("saves the fill-in answers and bumps the version", async () => {
    let res = await call("PUT", "/me/preferences", { role: "founder", lately: "  How Costco makes money  ", topics: ["pricing", "hiring"], platforms: ["x"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { profile: unknown }).profile).toMatchObject({
      role: "founder",
      lately: "How Costco makes money",
      topics: ["pricing", "hiring"],
      platforms: ["x"],
    });

    // Topics are replaced as a set; other fields are left alone.
    res = await call("PUT", "/me/preferences", { topics: ["hiring", "open source"] });
    const { profile } = (await res.json()) as { profile: { topics: string[]; role: string } };
    expect(profile.topics.sort()).toEqual(["hiring", "open source"]);
    expect(profile.role).toBe("founder");

    const [row] = await ctx.db.select().from(schema.profile).where(eq(schema.profile.userId, userId));
    expect(row!.version).toBe(2);
  });

  it("keeps learned topic weights when explicit topics change", async () => {
    await ctx.db.insert(schema.topicWeight).values({ userId, topic: "growth loops", origin: "learned", weight: 0.4 });
    await call("PUT", "/me/preferences", { topics: ["pricing"] });
    const rows = await ctx.db.select().from(schema.topicWeight).where(eq(schema.topicWeight.userId, userId));
    expect(rows.map((r) => `${r.origin}:${r.topic}`).sort()).toEqual(["explicit:pricing", "learned:growth loops"]);
  });

  it("stores kept import facts, screening them again", async () => {
    const res = await call("PUT", "/me/preferences", {
      imported: {
        assistant: "claude",
        facts: [
          { kind: "curious", text: "Usage-based pricing", fills: fills({ topics: ["pricing"] }) },
          { kind: "work", text: "My API key is in the doc", fills: fills() },
        ],
      },
    });
    const { profile } = (await res.json()) as { profile: { imported: unknown } };
    expect(profile.imported).toEqual({ importId: null, assistant: "claude", facts: [{ kind: "curious", text: "Usage-based pricing", fills: fills({ topics: ["pricing"] }) }] });
  });

  it("takes the user's own words for role, topics and places they read", async () => {
    const res = await call("PUT", "/me/preferences", {
      role: "product designer",
      topics: ["pricing", "Vertical SaaS", "vertical saas", "knitting"],
      platforms: ["substack", "LinkedIn", "linkedin"],
    });
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: { role: string; topics: string[]; platforms: string[] } };
    expect(profile.role).toBe("product designer");
    // Suggested topics first, then the user's own alphabetically; repeats differing only in case are dropped.
    expect(profile.topics).toEqual(["pricing", "knitting", "Vertical SaaS"]);
    expect(profile.platforms).toEqual(["substack", "LinkedIn"]);
  });

  it("rejects answers that are too long", async () => {
    expect((await call("PUT", "/me/preferences", { role: "x".repeat(81) })).status).toBe(400);
    expect((await call("PUT", "/me/preferences", { topics: ["x".repeat(61)] })).status).toBe(400);
  });
});

describe("/me/schedule", () => {
  it("turns a preset into weekdays, a local time and the next run", async () => {
    const res = await call("PUT", "/me/schedule", { preset: "weekday_mornings", timeZone: "Europe/London" });
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: { schedule: Record<string, unknown> } };
    expect(profile.schedule).toMatchObject({ preset: "weekday_mornings", weekdays: [1, 2, 3, 4, 5], localTime: "07:30", timeZone: "Europe/London", paused: false });
    const next = new Date(profile.schedule.nextRunAt as string);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })).toBe("07:30");
  });

  it("updates in place", async () => {
    await call("PUT", "/me/schedule", { preset: "sunday_mornings", timeZone: "America/New_York" });
    const rows = await ctx.db.select().from(schema.schedule).where(eq(schema.schedule.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weekdays: [0], localTime: "09:00", version: 2 });
    expect(rows[0]!.nextRunAt!.getUTCDay()).toBe(0);
  });

  it("rejects an unknown time zone", async () => {
    expect((await call("PUT", "/me/schedule", { preset: "lunch", timeZone: "Mars/Olympus" })).status).toBe(400);
  });
});

describe("POST /me/onboarding/import", () => {
  let importId: string;

  it("reads the note into facts that fill the form, screening what the model returns", async () => {
    const res = await call("POST", "/me/onboarding/import", { assistant: "chatgpt", text: NOTE });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { importId: string; facts: { text: string; fills: Record<string, unknown> }[]; dropped: unknown[] } };
    importId = result.importId;
    expect(result.facts.map((f) => f.text)).toEqual(["Founder of a two-person SaaS startup", "A scheduling tool for clinics", "Usage-based pricing", "Lenny's Newsletter"]);
    expect(result.facts[0]!.fills).toMatchObject({ role: "founder" });
    expect(result.facts[1]!.fills).toMatchObject({ lately: "a scheduling tool for clinics", topics: ["clinic software"] });
    expect(result.facts[3]!.fills).toMatchObject({ platforms: ["substack"], sources: [{ name: "Lenny's Newsletter", url: null }] });
    // One left out by the model, one by our own check.
    expect(result.dropped).toEqual([{ category: "health" }, { category: "health" }]);
    expect(imports.at(-1)).toEqual({ assistant: "chatgpt", text: NOTE });
  });

  it("keeps the pasted note with its reading", async () => {
    const [row] = await ctx.db.select().from(schema.profileImport).where(eq(schema.profileImport.id, importId));
    expect(row).toMatchObject({ userId, assistant: "chatgpt", rawText: NOTE, method: "anthropic", model: "test-model", promptVersion: "test-v1" });
    expect(row!.result.facts).toHaveLength(4);
  });

  it("returns the latest import, so the paste is there on return", async () => {
    const res = await call("GET", "/me/onboarding/import/latest");
    const { import: latest } = (await res.json()) as { import: { id: string; text: string; assistant: string; result: { importId: string } } };
    expect(latest).toMatchObject({ id: importId, text: NOTE, assistant: "chatgpt", result: { importId } });
  });

  it("links the kept facts to their import, and only to your own", async () => {
    const facts = [{ kind: "curious", text: "Usage-based pricing", fills: fills({ topics: ["pricing"] }) }];
    const res = await call("PUT", "/me/preferences", { imported: { importId, assistant: "chatgpt", facts } });
    expect(((await res.json()) as { profile: { imported: { importId: string } } }).profile.imported.importId).toBe(importId);

    const other = await signIn(ctx, "other-onboarding@example.com");
    expect((await call("PUT", "/me/preferences", { imported: { importId, assistant: "chatgpt", facts } }, other)).status).toBe(404);
    const { import: none } = (await (await call("GET", "/me/onboarding/import/latest", undefined, other)).json()) as { import: unknown };
    expect(none).toBeNull();
  });

  it("falls back to the plain parser when the model fails, and says so", async () => {
    importerFails = true;
    try {
      const res = await call("POST", "/me/onboarding/import", { assistant: "gemini", text: NOTE });
      const { result } = (await res.json()) as { result: { importId: string; facts: { text: string; fills: { role: string | null } }[]; dropped: unknown[] } };
      expect(result.facts.map((f) => f.text)).toContain("chasing the first ten paying customers");
      expect(result.facts[0]!.fills.role).toBe("founder");
      expect(result.dropped).toEqual([{ category: "health" }]);
      const [row] = await ctx.db.select().from(schema.profileImport).where(eq(schema.profileImport.id, result.importId));
      expect(row).toMatchObject({ method: "parser", model: null });
    } finally {
      importerFails = false;
    }
  });

  it("rejects an empty paste", async () => {
    expect((await call("POST", "/me/onboarding/import", { assistant: "claude", text: "   " })).status).toBe(400);
  });
});

describe("onboarding picks and reviews", () => {
  const items: Record<string, string> = {};

  beforeAll(async () => {
    const pubs = await ctx.db
      .insert(schema.publisher)
      .values(["a", "b", "c", "d", "e", "f"].map((k) => ({ key: `${k}.example.com`, name: `Publisher ${k.toUpperCase()}`, origin: "user_added" as const })))
      .returning();
    const rows: { title: string; tags: string[]; pub: number; quality?: string; excerpt?: string }[] = [
      { title: "How we priced our first B2B contract", tags: ["pricing"], pub: 0, excerpt: "We asked for three times what felt comfortable. They said yes in a day." },
      { title: "Another pricing teardown", tags: ["pricing tiers"], pub: 0 },
      { title: "Hiring your first engineer", tags: ["hiring"], pub: 1 },
      { title: "Ten SEO hacks", tags: ["pricing"], pub: 2, quality: "seo_filler" },
      { title: "Notes on watercolour", tags: ["art"], pub: 3 },
      { title: "Open source as a business", tags: ["open source"], pub: 4 },
      { title: "Monetising a GitHub project", tags: ["open source"], pub: 5 },
    ];
    for (const r of rows) {
      const [item] = await ctx.db
        .insert(schema.contentItem)
        .values({
          canonicalUrl: `https://${pubs[r.pub]!.key}/${encodeURIComponent(r.title)}`,
          type: "article",
          publisherId: pubs[r.pub]!.id,
          title: r.title,
          status: "enriched",
          tags: r.tags,
          qualityLabel: r.quality ?? "substantive",
          readTimeMinutes: 6,
          publishedAt: new Date(),
        })
        .returning();
      items[r.title] = item!.id;
      if (r.excerpt) {
        await ctx.db.insert(schema.contentVersion).values({ itemId: item!.id, contentHash: "h", sectionMap: [], rightsSnapshot: {}, excerpt: r.excerpt });
      }
    }
    await call("PUT", "/me/preferences", { topics: ["pricing", "hiring", "open source"] });
  });

  it("picks five: topic matches across publishers, then a wildcard, skipping thin and SEO pieces", async () => {
    const res = await call("GET", "/me/onboarding/picks");
    expect(res.status).toBe(200);
    const { picks } = (await res.json()) as { picks: { title: string; matchedTopic: string | null; quote: string | null; publisher: string }[] };
    expect(picks).toHaveLength(5);
    expect(picks.map((p) => p.title)).not.toContain("Ten SEO hacks");
    // One per publisher while there are enough publishers.
    expect(new Set(picks.map((p) => p.publisher)).size).toBe(5);
    expect(picks.find((p) => p.title === "Notes on watercolour")!.matchedTopic).toBeNull();
    // None of these came from a source this user added.
    expect(picks.every((p) => (p as unknown as { fromFollowedSource: boolean }).fromFollowedSource === false)).toBe(true);
    const priced = picks.find((p) => p.title === "How we priced our first B2B contract")!;
    expect(priced).toMatchObject({ matchedTopic: "pricing", quote: "We asked for three times what felt comfortable." });
    expect(picks.filter((p) => p.matchedTopic).map((p) => p.matchedTopic)).toEqual(expect.arrayContaining(["pricing", "hiring", "open source"]));
  });

  it("saves a review with reasons, and a second save overwrites it", async () => {
    const id = items["Hiring your first engineer"]!;
    let res = await call("PUT", `/items/${id}/review`, { vote: "interested", reasons: ["practical", "practical", "numbers"], freeText: "Real numbers", origin: "onboarding" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { review: unknown }).review).toMatchObject({ vote: "interested", reasons: ["practical", "numbers"], origin: "onboarding" });

    res = await call("PUT", `/items/${id}/review`, { vote: "not_interested" });
    expect(((await res.json()) as { review: unknown }).review).toMatchObject({ vote: "not_interested", reasons: [], freeText: null, origin: "onboarding" });
    const rows = await ctx.db.select().from(schema.review).where(eq(schema.review.itemId, id));
    expect(rows).toHaveLength(1);
  });

  it("leaves reviewed items out of the picks", async () => {
    const { picks } = (await (await call("GET", "/me/onboarding/picks")).json()) as { picks: { title: string }[] };
    expect(picks.map((p) => p.title)).not.toContain("Hiring your first engineer");
  });

  it("deletes a review, and 404s for an unknown item", async () => {
    const id = items["Hiring your first engineer"]!;
    expect((await call("DELETE", `/items/${id}/review`)).status).toBe(204);
    expect((await call("PUT", "/items/00000000-0000-4000-8000-000000000000/review", { vote: "interested" })).status).toBe(404);
    expect((await call("PUT", `/items/${id}/review`, { vote: "maybe" })).status).toBe(400);
  });
});

describe("POST /me/onboarding/complete", () => {
  it("marks onboarding done once", async () => {
    const first = (await (await call("POST", "/me/onboarding/complete")).json()) as { profile: { onboardedAt: string } };
    expect(first.profile.onboardedAt).not.toBeNull();
    const second = (await (await call("POST", "/me/onboarding/complete")).json()) as { profile: { onboardedAt: string } };
    expect(second.profile.onboardedAt).toBe(first.profile.onboardedAt);
  });
});
