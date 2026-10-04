import { randomUUID } from "node:crypto";
import type { ReaderWriter } from "@fs/ai";
import { schema } from "@fs/db";
import type { LetterItemSnapshot } from "@fs/db/schema";
import { activityMonthSchema, itemViewSchema, letterSummarySchema, letterViewSchema, postscriptSchema, savedPieceSchema, sectionSummarySchema } from "@fs/schema";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const { author, contentItem, contentVersion, interaction, letter, letterItem, profile, publisher, review, schedule, source, summary, topicWeight, transcript, user, userAuthor, userSource } =
  schema;

// A reader that records its calls; `fail` makes it throw like an unavailable model.
const readerCalls: string[] = [];
let readerFails = false;
const reader: ReaderWriter = {
  method: "anthropic",
  model: "test-haiku",
  async summarizeSection(input) {
    readerCalls.push(`summarize:${input.sectionTitle ?? ""}`);
    if (readerFails) throw new Error("overloaded");
    if (input.text.includes("INVENT")) return { claim: "It made 4242 dollars.", evidence: "Trust me.", forYou: "x" };
    return { claim: "Renewals carry the profit.", evidence: "Prices sit near cost.", forYou: "Keep usage pricing predictable." };
  },
  async forYou() {
    readerCalls.push("forYou");
    return "Relevant to your pricing work.";
  },
  async recap(input) {
    readerCalls.push(`recap:${input.pieces.map((p) => `${p.title}=${p.verdict ?? "none"}${p.reasons.length ? `(${p.reasons.join(",")})` : ""}`).join("+")}`);
    if (readerFails) throw new Error("overloaded");
    await new Promise((r) => setTimeout(r, 20));
    const voted = input.pieces.filter((p) => p.verdict);
    // A title with INVENT gets a recap that fails the checks (another piece, a new number).
    if (voted.some((p) => p.title.includes("INVENT"))) return "You'll love “Ten pricing myths”, up 400%.";
    return `You weighed in on ${voted.map((p) => `“${p.title}”`).join(" and ")}.`;
  },
};

const ctx = createTestApp({ reader });
// Test files share one database, and other suites (onboarding's picks) read every item: clean up after.
const created = { items: [] as string[], sources: [] as string[], publishers: [] as string[] };
afterAll(async () => {
  await ctx.db.delete(userSource).where(inArray(userSource.sourceId, created.sources));
  await ctx.db.delete(contentItem).where(inArray(contentItem.id, created.items));
  await ctx.db.delete(source).where(inArray(source.id, created.sources));
  await ctx.db.delete(publisher).where(inArray(publisher.id, created.publishers));
  await ctx.pool.end();
});

let cookie: string;
let userId: string;
let otherCookie: string;
let otherId: string;
// The P.S. tests' own user, so their letters don't change the other tests' "today" and lists.
let psCookie: string;
let psUser: string;
const idOf = async (email: string) => (await ctx.db.select().from(user).where(eq(user.email, email)))[0]!.id;
beforeAll(async () => {
  cookie = await signIn(ctx, "letters@example.com");
  userId = await idOf("letters@example.com");
  otherCookie = await signIn(ctx, "letters-other@example.com");
  otherId = await idOf("letters-other@example.com");
  psCookie = await signIn(ctx, "letters-ps@example.com");
  psUser = await idOf("letters-ps@example.com");
  await ctx.db.insert(profile).values({ userId, role: "founder", lately: "membership pricing" });
  await ctx.db.insert(topicWeight).values({ userId, topic: "pricing", origin: "explicit" });
  await ctx.db.insert(schedule).values({ userId, weekdays: [1, 2, 3, 4, 5], localTime: "07:30", timeZone: "America/New_York", nextRunAt: new Date("2030-01-07T12:30:00Z") });
});

const call = (method: string, path: string, body?: unknown, as = cookie) =>
  ctx.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ── Seeding: what the workers would have produced ──────────────────────────

const rightsFull = { display: "full_text", retainText: true, offlineAllowed: true, licenseNote: null, storeBlocks: true, digest: false, unavailableReason: null };

async function seedPublisher(key: string) {
  const [p] = await ctx.db.insert(publisher).values({ key, name: `${key} Weekly`, origin: "user_added" }).returning();
  const [s] = await ctx.db
    .insert(source)
    .values({ canonicalKey: `https://${key}/feed`, type: "feed", publisherId: p!.id, title: key, inputUrl: `https://${key}/`, fetchUrl: `https://${key}/feed` })
    .returning();
  created.publishers.push(p!.id);
  created.sources.push(s!.id);
  return { publisherId: p!.id, sourceId: s!.id };
}

async function seedArticle({
  title = "The fee is the product",
  text = ["A membership store makes most of its profit from the fee.", "Prices stay close to cost, so members renew."],
  rights = rightsFull as Record<string, unknown>,
  authorKey = null as string | null,
  authorName = null as string | null,
  status = "extracted" as "extracted" | "metadata_only",
  statusReason = null as string | null,
} = {}) {
  const site = `${randomUUID().slice(0, 8)}.test`;
  const { publisherId, sourceId } = await seedPublisher(site);
  const [item] = await ctx.db
    .insert(contentItem)
    .values({ canonicalUrl: `https://${site}/a`, type: "article", sourceId, publisherId, title, status, statusReason, readTimeMinutes: 6, authorKey, authorName, leadImageUrl: `https://${site}/lead.jpg` })
    .returning();
  created.items.push(item!.id);
  const blocks = [
    { type: "paragraph", text: text[0] },
    { type: "heading", level: 2, text: "What it means" },
    { type: "paragraph", text: text[1] },
  ];
  const sections = [
    { id: "s1", title: null, startBlock: 0, endBlock: 1 },
    { id: "s2", title: "What it means", startBlock: 1, endBlock: 3 },
  ];
  const keep = (rights as { storeBlocks?: boolean }).storeBlocks !== false && status === "extracted";
  const key = keep ? `items/${item!.id}/blocks-h.json` : null;
  if (key) await ctx.store.putJson(key, { blocks, sections });
  const [v] = await ctx.db
    .insert(contentVersion)
    .values({ itemId: item!.id, contentHash: "h", blocksKey: key, sectionMap: sections, rightsSnapshot: rights, excerpt: "A membership store makes most of its profit." })
    .returning();
  return { item: item!, versionId: v!.id, publisherId, site };
}

async function seedVideo() {
  const site = `youtube:UC${randomUUID().slice(0, 6)}`;
  const { publisherId, sourceId } = await seedPublisher(site);
  const [item] = await ctx.db
    .insert(contentItem)
    .values({ canonicalUrl: `https://www.youtube.com/watch?v=${randomUUID().slice(0, 11)}`, type: "video", externalId: "dQw4w9WgXcQ", sourceId, publisherId, title: "Hiring your first engineer", status: "extracted", durationSeconds: 1083 })
    .returning();
  created.items.push(item!.id);
  const segments = Array.from({ length: 120 }, (_, i) => ({ text: `Point ${i} about hiring.`, offsetMs: i * 9000, durationMs: 8000 }));
  const key = `items/${item!.id}/transcript-h.json`;
  await ctx.store.putJson(key, { segments });
  const [v] = await ctx.db.insert(contentVersion).values({ itemId: item!.id, contentHash: "h", blocksKey: null, sectionMap: [], rightsSnapshot: rightsFull }).returning();
  await ctx.db.insert(transcript).values({ itemVersionId: v!.id, provider: "fake", provenance: "native", key });
  return { item: item! };
}

const snapshot = (over: Partial<LetterItemSnapshot> & { title: string }): LetterItemSnapshot => ({
  kind: "article",
  topic: "Pricing",
  minutes: 6,
  whyPicked: "Because you said “membership pricing”.",
  summary: "Why the shop runs near cost and the renewal pays the bills.",
  tag: null,
  sourceName: "Membership Economics",
  originalUrl: "https://example.com/a",
  image: { url: "https://images.unsplash.com/photo-1?ixid=x", source: "stock", credit: "Oxana Melis on Unsplash", creditUrl: "https://unsplash.com/@oxana?utm_source=founder_signal&utm_medium=referral" },
  author: null,
  evidenceIds: ["x.p1"],
  profileVersion: 1,
  ...over,
});

async function seedLetter(owner: string, items: { itemId: string; snap: LetterItemSnapshot }[], over: Partial<typeof letter.$inferInsert> = {}) {
  const [l] = await ctx.db
    .insert(letter)
    .values({
      userId: owner,
      occurrenceId: `2026-10-${randomUUID()}#1`,
      status: "sent",
      scheduledFor: new Date(),
      localDate: "2026-10-05",
      deliveredAt: new Date(),
      headline: "Pricing and hiring, for a founder",
      intro: "Three things I picked for you. 33 minutes in all.",
      leanings: ["Pricing, with numbers", "Short reads", "Something new"],
      ...over,
    })
    .returning();
  if (items.length) {
    await ctx.db.insert(letterItem).values(items.map((x, i) => ({ letterId: l!.id, itemId: x.itemId, position: i + 1, feedbackCode: `PR${22 + i}`, snapshot: x.snap })));
  }
  return l!;
}

const event = (type: string, itemId: string, at: string, letterId: string | null = null, localDay = at.slice(0, 10)) => ({
  eventId: randomUUID(),
  type,
  itemId,
  letterId,
  occurredAt: at,
  localDay,
});

// ── Letters ─────────────────────────────────────────────────────────────────

describe("/letters", () => {
  let priya: Awaited<ReturnType<typeof seedArticle>>;
  let older: Awaited<ReturnType<typeof seedArticle>>;
  let video: Awaited<ReturnType<typeof seedVideo>>;
  let current: typeof letter.$inferSelect;

  beforeAll(async () => {
    priya = await seedArticle({ title: "How we priced our first contract", authorKey: "priya.test:priya-raman", authorName: "Priya Raman" });
    older = await seedArticle({ title: "An older Priya piece", authorKey: "priya.test:priya-raman", authorName: "Priya Raman" });
    video = await seedVideo();
    await ctx.db.insert(author).values({
      key: "priya.test:priya-raman",
      name: "Priya Raman",
      initials: "PR",
      role: "Founder, clinic scheduling software",
      headline: "3 companies founded",
      short: "Writes up every pricing decision in public.",
      bio: "Priya has founded three companies.",
      stats: [{ value: "3", label: "companies founded", source: { name: "Crunchbase", url: "https://crunchbase.com/p" } }],
      knownFor: ["Pricing write-ups"],
      siteUrl: "https://priya.test",
      followUrl: "https://priya.test/feed",
      provenance: "From priya.test and Crunchbase, checked Oct 3",
      enrichmentStatus: "enriched",
      checkedAt: new Date(),
    });
    const first = await seedArticle({ title: "The fee is the product" });
    current = await seedLetter(userId, [
      { itemId: first.item.id, snap: snapshot({ title: "The fee is the product" }) },
      { itemId: priya.item.id, snap: snapshot({ title: "How we priced our first contract", whyPicked: null, tag: "New source", author: { key: "priya.test:priya-raman", name: "Priya Raman" }, image: null }) },
      { itemId: video.item.id, snap: snapshot({ title: "Hiring your first engineer", kind: "video", topic: "Hiring", minutes: 18 }) },
    ], { number: 4 });
    // The user read and saved an older piece by the same author.
    await call("POST", "/events", { events: [event("open", older.item.id, "2026-10-02T08:00:00Z"), event("complete", older.item.id, "2026-10-02T08:05:00Z")] });
  });

  it("requires sign-in", async () => {
    for (const [method, path] of [
      ["GET", "/letters/today"],
      ["GET", "/letters"],
      ["GET", `/letters/${current.id}`],
      ["PUT", `/letters/${current.id}/leanings`],
      ["GET", `/items/${priya.item.id}`],
      ["POST", `/items/${priya.item.id}/summary`],
      ["POST", "/events"],
      ["GET", "/me/saved"],
      ["GET", "/me/activity?month=2026-10"],
      ["PUT", "/me/authors/x/follow"],
      ["POST", "/me/schedule/test-letter"],
    ] as const) {
      expect((await ctx.app.request(`${BASE_URL}${path}`, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("returns null for today when nothing was delivered", async () => {
    const res = await call("GET", "/letters/today", undefined, otherCookie);
    expect(await res.json()).toEqual({ letter: null });
  });

  it("returns today's letter in the contract shape, with the user's state per piece", async () => {
    await call("PUT", `/items/${priya.item.id}/review`, { vote: "not_interested", reasons: ["too_basic"] });
    await call("POST", "/events", {
      events: [
        event("save", video.item.id, "2026-10-05T08:00:00Z", current.id),
        event("open", video.item.id, "2026-10-05T08:01:00Z", current.id),
        event("complete", video.item.id, "2026-10-05T08:20:00Z", current.id),
        event("skip", priya.item.id, "2026-10-05T08:21:00Z", current.id),
      ],
    });
    const res = await call("GET", "/letters/today");
    expect(res.status).toBe(200);
    const { letter: view } = (await res.json()) as { letter: unknown };
    const l = letterViewSchema.parse(view);
    expect(l).toMatchObject({ id: current.id, number: 4, status: "sent", localDate: "2026-10-05", totalMinutes: 30, isTest: false, whyThisMix: null });
    expect(l.pieces.map((p) => [p.position, p.feedbackCode, p.kind])).toEqual([
      [1, "PR22", "article"],
      [2, "PR23", "article"],
      [3, "PR24", "video"],
    ]);
    expect(l.pieces[1]).toMatchObject({ verdict: "not_interested", skipped: true, completed: false, saved: false, tag: "New source", image: null });
    expect(l.pieces[2]).toMatchObject({ verdict: null, skipped: false, completed: true, saved: true });
    // A verdict (here a dislike) means the P.S. is the recap written from the feedback.
    expect(l.postscript).toEqual({
      recap: "You weighed in on “How we priced our first contract”.",
      nextLetterAt: "2030-01-07T12:30:00.000Z",
      leanings: ["Pricing, with numbers", "Short reads", "Something new"],
      chosenLeanings: [],
    });
  });

  it("shows the author card: sourced details without their sources, the user's reading, and the follow", async () => {
    const { letter: l } = (await (await call("GET", `/letters/${current.id}`)).json()) as { letter: ReturnType<typeof letterViewSchema.parse> };
    const card = l.pieces[1]!.author!;
    expect(card).toEqual({
      key: "priya.test:priya-raman",
      name: "Priya Raman",
      initials: "PR",
      role: "Founder, clinic scheduling software",
      headline: "3 companies founded",
      short: "Writes up every pricing decision in public.",
      bio: "Priya has founded three companies.",
      stats: [{ value: "3", label: "companies founded" }],
      knownFor: ["Pricing write-ups"],
      siteUrl: "https://priya.test",
      provenance: "From priya.test and Crunchbase, checked Oct 3",
      yourReading: [{ itemId: older.item.id, title: "An older Priya piece", note: "Read Oct 2" }],
      following: false,
    });
    expect(l.pieces[0]!.author).toBeNull();
  });

  it("shows the default P.S. until there's feedback, rewrites it from all verdicts, and goes back when it's removed", async () => {
    const a = await seedArticle({ title: "The fee is the product" });
    const b = await seedArticle({ title: "Pricing pages that convert" });
    const ps = await seedLetter(
      psUser,
      [
        { itemId: a.item.id, snap: snapshot({ title: "The fee is the product" }) },
        { itemId: b.item.id, snap: snapshot({ title: "Pricing pages that convert" }) },
      ],
      { postscriptDefault: "Two on pricing: “The fee is the product” and “Pricing pages that convert”." },
    );
    const recap = async () => letterViewSchema.parse(((await (await call("GET", `/letters/${ps.id}`, undefined, psCookie)).json()) as { letter: unknown }).letter).postscript.recap;
    const row = async () => (await ctx.db.select().from(letter).where(eq(letter.id, ps.id)))[0]!;
    readerCalls.length = 0;

    // No feedback: the stored default, with no model call.
    expect(await recap()).toBe("Two on pricing: “The fee is the product” and “Pricing pages that convert”.");
    expect(readerCalls).toEqual([]);

    // A verdict: rewritten from all the pieces, with their verdicts and reasons, then cached.
    await call("PUT", `/items/${a.item.id}/review`, { vote: "interested", reasons: ["practical"] }, psCookie);
    expect(await recap()).toBe("You weighed in on “The fee is the product”.");
    expect(readerCalls).toEqual(["recap:The fee is the product=interested(practical)+Pricing pages that convert=none"]);
    expect((await row()).postscriptRecapMeta).toEqual({ method: "anthropic", model: "test-haiku", promptVersion: "recap-v2" });
    await recap();
    expect(readerCalls).toHaveLength(1);

    // A skip isn't feedback on the piece; a changed verdict is, and two reads at once make one call.
    await call("POST", "/events", { events: [event("skip", b.item.id, "2026-10-05T09:00:00Z", ps.id)] }, psCookie);
    await recap();
    expect(readerCalls).toHaveLength(1);
    await call("PUT", `/items/${b.item.id}/review`, { vote: "not_interested", reasons: ["too_basic"] }, psCookie);
    const [r1, r2] = await Promise.all([recap(), recap()]);
    expect(r1).toBe("You weighed in on “The fee is the product” and “Pricing pages that convert”.");
    expect(r2).toBe(r1);
    expect(readerCalls).toHaveLength(2);
    expect(readerCalls[1]).toBe("recap:The fee is the product=interested(practical)+Pricing pages that convert=not_interested(too_basic)");

    // The model failing: the plain recap from the user's own reasons.
    await call("PUT", `/items/${a.item.id}/review`, { vote: "interested", reasons: ["practical", "numbers"] }, psCookie);
    readerFails = true;
    expect(await recap()).toBe(
      "You marked “The fee is the product” worth it, for how practical it was and the numbers. “Pricing pages that convert” wasn't for you: too basic.",
    );
    readerFails = false;
    expect(readerCalls).toHaveLength(3);
    expect((await row()).postscriptRecapMeta).toEqual({ method: "fallback", model: null, promptVersion: "recap-v2", fallbackReason: "overloaded" });

    // All feedback removed: back to the default, without a model call.
    await call("DELETE", `/items/${a.item.id}/review`, undefined, psCookie);
    await call("DELETE", `/items/${b.item.id}/review`, undefined, psCookie);
    expect(await recap()).toBe("Two on pricing: “The fee is the product” and “Pricing pages that convert”.");
    expect(readerCalls).toHaveLength(3);
    expect(await row()).toMatchObject({ postscriptRecap: null, postscriptRecapSignature: null, postscriptRecapMeta: null });
  });

  it("falls back when the model's recap names another piece or adds a number", async () => {
    const a = await seedArticle({ title: "INVENT a pricing page" });
    const ps = await seedLetter(psUser, [{ itemId: a.item.id, snap: snapshot({ title: "INVENT a pricing page" }) }], {
      postscriptDefault: "Today was “INVENT a pricing page”.",
    });
    await call("PUT", `/items/${a.item.id}/review`, { vote: "not_interested", reasons: [] }, psCookie);
    const l = letterViewSchema.parse(((await (await call("GET", `/letters/${ps.id}`, undefined, psCookie)).json()) as { letter: unknown }).letter);
    expect(l.postscript.recap).toBe("“INVENT a pricing page” wasn't for you.");
    const [row] = await ctx.db.select().from(letter).where(eq(letter.id, ps.id));
    expect(row!.postscriptRecapMeta).toMatchObject({ method: "fallback", fallbackReason: expect.stringContaining("postscript_names_other_piece") });
  });

  it("gives a letter from before default recaps one from its titles, stored on first read", async () => {
    const a = await seedArticle({ title: "An old letter's piece" });
    const old = await seedLetter(psUser, [{ itemId: a.item.id, snap: snapshot({ title: "An old letter's piece" }) }]);
    expect(old.postscriptDefault).toBeNull();
    readerCalls.length = 0;
    const l = letterViewSchema.parse(((await (await call("GET", `/letters/${old.id}`, undefined, psCookie)).json()) as { letter: unknown }).letter);
    expect(l.postscript.recap).toBe("Today was “An old letter's piece”. Tell me if it was worth your time.");
    expect(readerCalls).toEqual([]);
    const [row] = await ctx.db.select().from(letter).where(eq(letter.id, old.id));
    expect(row!.postscriptDefault).toBe(l.postscript.recap);
  });

  it("stores the chosen leanings", async () => {
    const res = await call("PUT", `/letters/${current.id}/leanings`, { chosen: ["Short reads", "short reads", "Founder interviews"] });
    expect(res.status).toBe(200);
    const { postscript } = (await res.json()) as { postscript: unknown };
    expect(postscriptSchema.parse(postscript).chosenLeanings).toEqual(["Short reads", "Founder interviews"]);
    const [row] = await ctx.db.select().from(letter).where(eq(letter.id, current.id));
    expect(row!.chosenLeanings).toEqual(["Short reads", "Founder interviews"]);
    expect((await call("PUT", `/letters/${current.id}/leanings`, { chosen: ["x".repeat(81)] })).status).toBe(400);
    expect((await call("PUT", `/letters/${current.id}/leanings`, { chosen: [] }, otherCookie)).status).toBe(404);
  });

  it("keeps letters private, and 404s malformed IDs", async () => {
    expect((await call("GET", `/letters/${current.id}`, undefined, otherCookie)).status).toBe(404);
    expect((await call("GET", "/letters/not-a-uuid")).status).toBe(404);
    expect((await call("GET", `/letters/${randomUUID()}`)).status).toBe(404);
  });

  it("shows a letter still being put together, for the app to poll", async () => {
    const pending = await seedLetter(userId, [], { status: "generating", deliveredAt: null, headline: null, intro: null, isTest: true, occurrenceId: `test#${randomUUID()}` });
    const l = letterViewSchema.parse(((await (await call("GET", `/letters/${pending.id}`)).json()) as { letter: unknown }).letter);
    expect(l).toMatchObject({ status: "generating", pieces: [], headline: "", deliveredAt: null, number: 5, isTest: true });
    // Not delivered, so not today's letter.
    expect((((await (await call("GET", "/letters/today")).json()) as { letter: { id: string } }).letter).id).toBe(current.id);
  });

  it("lists delivered letters newest first, by cursor", async () => {
    const base = Date.now() - 100 * 86_400_000;
    for (let i = 0; i < 22; i++) {
      await seedLetter(otherId, [], { deliveredAt: new Date(base + i * 86_400_000), number: i + 1, localDate: `2026-01-${String(i + 1).padStart(2, "0")}` });
    }
    await seedLetter(otherId, [], { status: "skipped", deliveredAt: null });
    const first = (await (await call("GET", "/letters", undefined, otherCookie)).json()) as { letters: unknown[]; nextCursor: string | null };
    expect(first.letters).toHaveLength(20);
    const parsed = first.letters.map((x) => letterSummarySchema.parse(x));
    expect(parsed[0]).toMatchObject({ number: 22, pieceCount: 0, totalMinutes: 0 });
    expect(first.nextCursor).toBeTruthy();
    const second = (await (await call("GET", `/letters?cursor=${first.nextCursor}`, undefined, otherCookie)).json()) as { letters: { number: number }[]; nextCursor: string | null };
    expect(second.letters.map((l) => l.number)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    expect((await call("GET", "/letters?cursor=garbage", undefined, otherCookie)).status).toBe(400);

    const mine = (await (await call("GET", "/letters")).json()) as { letters: unknown[] };
    expect(mine.letters.map((x) => letterSummarySchema.parse(x))).toEqual([
      { id: current.id, number: 4, headline: "Pricing and hiring, for a founder", localDate: "2026-10-05", totalMinutes: 30, isTest: false, pieceCount: 3 },
    ]);
  });
});

// ── Items ───────────────────────────────────────────────────────────────────

describe("/items/:id", () => {
  it("returns full text from the content store when rights allow it", async () => {
    const { item } = await seedArticle();
    const res = await call("GET", `/items/${item.id}`);
    expect(res.status).toBe(200);
    const view = itemViewSchema.parse(((await res.json()) as { item: unknown }).item);
    expect(view).toMatchObject({ kind: "article", minutes: 6, digest: null, video: null, unavailableReason: null, rights: { display: "full_text", offlineAllowed: true } });
    expect(view.blocks).toHaveLength(3);
    expect(view.sections.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("returns a digest when rights don't allow the full text", async () => {
    const { item } = await seedArticle({ rights: { display: "excerpt_only", retainText: true, offlineAllowed: false, licenseNote: "digest only", storeBlocks: true, digest: true } });
    const view = itemViewSchema.parse(((await (await call("GET", `/items/${item.id}`)).json()) as { item: unknown }).item);
    expect(view).toMatchObject({ blocks: null, sections: [], digest: "A membership store makes most of its profit.", rights: { display: "excerpt_only", licenseNote: "digest only" } });
  });

  it("says why a metadata-only item has no body", async () => {
    const { item } = await seedArticle({ status: "metadata_only", statusReason: "paywalled", rights: { display: "link_only", retainText: false, offlineAllowed: false, storeBlocks: false } });
    const view = itemViewSchema.parse(((await (await call("GET", `/items/${item.id}`)).json()) as { item: unknown }).item);
    expect(view).toMatchObject({ blocks: null, unavailableReason: "paywalled" });
  });

  it("returns a video's ID, duration and transcript chapters", async () => {
    const { item } = await seedVideo();
    const view = itemViewSchema.parse(((await (await call("GET", `/items/${item.id}`)).json()) as { item: unknown }).item);
    expect(view).toMatchObject({ kind: "video", minutes: 18, blocks: null, video: { youtubeId: "dQw4w9WgXcQ", durationSeconds: 1083 } });
    expect(view.video!.chapters!.length).toBeGreaterThanOrEqual(4);
    expect(view.video!.chapters!.length).toBeLessThanOrEqual(8);
    expect(view.video!.chapters![0]).toMatchObject({ startSeconds: 0, title: "Point 0 about hiring" });
  });

  it("404s unknown items", async () => {
    expect((await call("GET", `/items/${randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/items/nope")).status).toBe(404);
  });
});

describe("/items/:id/summary", () => {
  beforeEach(() => {
    readerCalls.length = 0;
  });

  it("summarizes a section, caches claim and evidence, and writes 'for you' per user", async () => {
    const { item, versionId } = await seedArticle();
    const res = await call("POST", `/items/${item.id}/summary`, { sectionId: "s2" });
    expect(res.status).toBe(200);
    expect(sectionSummarySchema.parse(((await res.json()) as { summary: unknown }).summary)).toEqual({
      sectionId: "s2",
      claim: "Renewals carry the profit.",
      evidence: "Prices sit near cost.",
      forYou: "Keep usage pricing predictable.",
    });
    expect(readerCalls).toEqual(["summarize:What it means"]);
    const cached = await ctx.db.select().from(summary).where(eq(summary.itemVersionId, versionId));
    expect(cached).toHaveLength(1);
    expect(cached[0]).not.toHaveProperty("forYou");

    const again = (await (await call("POST", `/items/${item.id}/summary`, { sectionId: "s2" }, otherCookie)).json()) as { summary: { forYou: string; claim: string } };
    expect(again.summary).toMatchObject({ claim: "Renewals carry the profit.", forYou: "Relevant to your pricing work." });
    expect(readerCalls).toEqual(["summarize:What it means", "forYou"]);
  });

  it("doesn't use a summary with numbers the section doesn't contain", async () => {
    const { item, versionId } = await seedArticle({ text: ["INVENT nothing here, just prose about pricing.", "More prose."] });
    const out = (await (await call("POST", `/items/${item.id}/summary`, { sectionId: "s1" })).json()) as { summary: { claim: string; forYou: string } };
    expect(out.summary.claim).toBe("INVENT nothing here, just prose about pricing.");
    expect(out.summary.forYou).toBe("This section is about pricing, one of your topics.");
    expect(await ctx.db.select().from(summary).where(eq(summary.itemVersionId, versionId))).toHaveLength(0);
  });

  it("falls back to the section's own sentences when the model fails", async () => {
    const { item } = await seedArticle();
    readerFails = true;
    const out = (await (await call("POST", `/items/${item.id}/summary`, { sectionId: "s2" })).json()) as { summary: { claim: string } };
    readerFails = false;
    expect(out.summary.claim).toBe("What it means\n\nPrices stay close to cost, so members renew.");
  });

  it("summarizes a video chapter", async () => {
    const { item } = await seedVideo();
    const res = await call("POST", `/items/${item.id}/summary`, { sectionId: "c2" });
    expect(res.status).toBe(200);
    expect(readerCalls[0]).toMatch(/^summarize:Point \d+ about hiring$/);
  });

  it("refuses unknown sections and pieces whose rights don't allow it", async () => {
    const { item } = await seedArticle();
    expect((await call("POST", `/items/${item.id}/summary`, { sectionId: "s9" })).status).toBe(404);
    expect((await call("POST", `/items/${item.id}/summary`, {})).status).toBe(400);
    const digest = await seedArticle({ rights: { display: "link_only", retainText: false, offlineAllowed: false, storeBlocks: false } });
    const res = await call("POST", `/items/${digest.item.id}/summary`, { sectionId: "s1" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "FULL_TEXT_UNLICENSED" });
  });
});

// ── Events, saved, activity ─────────────────────────────────────────────────

describe("/events, /me/saved, /me/activity", () => {
  it("is idempotent on event IDs and drops events for unknown items", async () => {
    const { item } = await seedArticle();
    const othersLetter = await seedLetter(otherId, []);
    const events = [event("open", item.id, "2026-09-03T08:00:00Z", othersLetter.id), event("open", randomUUID(), "2026-09-03T08:00:00Z")];
    expect(await (await call("POST", "/events", { events })).json()).toEqual({ accepted: 1 });
    expect(await (await call("POST", "/events", { events })).json()).toEqual({ accepted: 1 });
    const rows = await ctx.db.select().from(interaction).where(eq(interaction.itemId, item.id));
    expect(rows).toHaveLength(1);
    // Someone else's letter isn't attached.
    expect(rows[0]!.letterId).toBeNull();
    expect((await call("POST", "/events", { events: [] })).status).toBe(400);
    expect((await call("POST", "/events", { events: [{ ...events[0], localDay: "3 Sep" }] })).status).toBe(400);
  });

  it("lists saved pieces newest first, honoring unsave", async () => {
    const a = await seedArticle({ title: "Saved A" });
    const b = await seedArticle({ title: "Saved then unsaved" });
    const c = await seedArticle({ title: "Saved C" });
    await seedLetter(userId, [{ itemId: c.item.id, snap: snapshot({ title: "Saved C", topic: "Sales", minutes: 9 }) }], { deliveredAt: new Date(Date.now() - 365 * 86_400_000) });
    await call("POST", "/events", {
      events: [
        event("save", a.item.id, "2026-09-10T08:00:00Z"),
        event("save", b.item.id, "2026-09-11T08:00:00Z"),
        event("unsave", b.item.id, "2026-09-11T09:00:00Z"),
        event("save", c.item.id, "2026-09-12T08:00:00Z"),
      ],
    });
    const { saved } = (await (await call("GET", "/me/saved")).json()) as { saved: unknown[] };
    const parsed = saved.map((s) => savedPieceSchema.parse(s));
    const mine = parsed.filter((p) => [a.item.id, b.item.id, c.item.id].includes(p.itemId));
    expect(mine.map((p) => p.title)).toEqual(["Saved C", "Saved A"]);
    expect(mine[0]).toMatchObject({ topic: "Sales", minutes: 9, offline: true, savedAt: "2026-09-12T08:00:00.000Z", image: { source: "stock" } });
    expect(mine[1]).toMatchObject({ topic: null, minutes: 6, image: { source: "article" } });
  });

  it("counts distinct items read (open + complete) or reviewed per local day", async () => {
    const a = await seedArticle();
    const b = await seedArticle();
    const c = await seedArticle();
    await call("POST", "/events", {
      events: [
        // Read on Nov 3 (New York evening, already Nov 4 in UTC): the device's day counts.
        event("open", a.item.id, "2026-11-04T01:00:00Z", null, "2026-11-03"),
        event("complete", a.item.id, "2026-11-04T01:10:00Z", null, "2026-11-03"),
        // A plain open doesn't count.
        event("open", b.item.id, "2026-11-05T10:00:00Z"),
        // Completed by accident, then undone.
        event("open", c.item.id, "2026-11-06T10:00:00Z"),
        event("complete", c.item.id, "2026-11-06T10:01:00Z"),
        event("uncomplete", c.item.id, "2026-11-06T10:02:00Z"),
      ],
    });
    await ctx.db.insert(review).values({ userId, itemId: b.item.id, vote: "interested", origin: "in_app", createdAt: new Date("2026-11-05T15:00:00Z") });

    const res = await call("GET", "/me/activity?month=2026-11");
    const { activity } = (await res.json()) as { activity: unknown };
    const m = activityMonthSchema.parse(activity);
    expect(m.days).toHaveLength(30);
    expect(m.days[2]).toEqual({ day: "2026-11-03", level: 1, read: 1, reviewed: 0 });
    expect(m.days[3]!.level).toBe(0);
    expect(m.days[4]).toEqual({ day: "2026-11-05", level: 1, read: 0, reviewed: 1 });
    expect(m.days[5]!.level).toBe(0);
    expect(m.activeDays).toBe(2);
    expect((await call("GET", "/me/activity?month=2026-13")).status).toBe(400);
    expect((await call("GET", "/me/activity")).status).toBe(400);
  });
});

// ── Authors ─────────────────────────────────────────────────────────────────

describe("PUT /me/authors/:key/follow", () => {
  it("follows an author and adds their feed as a source", async () => {
    await ctx.db.insert(author).values({ key: "dana.test:dana", name: "Dana", initials: "D", followUrl: "https://dana.test/feed.xml" });
    ctx.web.set("https://dana.test/feed.xml", {
      contentType: "application/rss+xml",
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Dana's letters</title><link>https://dana.test/</link><item><title>A</title><link>https://dana.test/a</link></item></channel></rss>`,
    });
    const res = await call("PUT", `/me/authors/${encodeURIComponent("dana.test:dana")}/follow`, { following: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "dana.test:dana", following: true });
    const [link] = await ctx.db.select().from(userAuthor).where(eq(userAuthor.userId, userId));
    expect(link!.sourceId).toBeTruthy();
    const [us] = await ctx.db.select().from(userSource).where(and(eq(userSource.userId, userId), eq(userSource.sourceId, link!.sourceId!)));
    expect(us).toMatchObject({ mode: "more_like_this", blocked: false });

    // Following again is idempotent.
    expect((await call("PUT", `/me/authors/dana.test:dana/follow`, { following: true })).status).toBe(200);
    expect(await ctx.db.select().from(userAuthor).where(eq(userAuthor.userId, userId))).toHaveLength(1);

    expect(await (await call("PUT", `/me/authors/dana.test:dana/follow`, { following: false })).json()).toEqual({ key: "dana.test:dana", following: false });
    expect(await ctx.db.select().from(userAuthor).where(eq(userAuthor.userId, userId))).toHaveLength(0);
  });

  it("still follows when the feed can't be added, and 404s unknown authors", async () => {
    await ctx.db.insert(author).values({ key: "gone.test:x", name: "X", initials: "X", followUrl: "https://gone.test/feed" });
    expect(await (await call("PUT", "/me/authors/gone.test:x/follow", { following: true })).json()).toEqual({ key: "gone.test:x", following: true });
    expect((await call("PUT", "/me/authors/nobody/follow", { following: true })).status).toBe(404);
    expect((await call("PUT", "/me/authors/gone.test:x/follow", { following: "yes" })).status).toBe(400);
  });
});

// ── Test letter ─────────────────────────────────────────────────────────────

describe("POST /me/schedule/test-letter", () => {
  it("creates a test occurrence for the pipeline without touching next_run_at", async () => {
    const res = await call("POST", "/me/schedule/test-letter");
    expect(res.status).toBe(202);
    const { letterId } = (await res.json()) as { letterId: string };
    const [row] = await ctx.db.select().from(letter).where(eq(letter.id, letterId));
    expect(row).toMatchObject({ userId, isTest: true, status: "scheduled" });
    expect(row!.occurrenceId).toMatch(/^test#[0-9a-f-]{36}$/);
    // No queue locally: the watchdog starts it on the dev runner's next tick.
    expect(row!.watchdogAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const [s] = await ctx.db.select().from(schedule).where(eq(schedule.userId, userId));
    expect(s!.nextRunAt!.toISOString()).toBe("2030-01-07T12:30:00.000Z");
  });

  it("queues the first step when there's a queue, and is rate-limited", async () => {
    const queued = createTestApp({ withQueue: true });
    try {
      const c = await signIn(queued, "letters-queue@example.com");
      const go = () => queued.app.request(`${BASE_URL}/me/schedule/test-letter`, { method: "POST", headers: { cookie: c } });
      const first = (await (await go()).json()) as { letterId: string };
      expect(queued.startedLetters).toEqual([first.letterId]);
      const [row] = await queued.db.select().from(letter).where(eq(letter.id, first.letterId));
      expect(row!.watchdogAt!.getTime()).toBeGreaterThan(Date.now());
      for (let i = 0; i < 4; i++) expect((await go()).status).toBe(202);
      expect((await go()).status).toBe(429);
    } finally {
      await queued.pool.end();
    }
  });
});
