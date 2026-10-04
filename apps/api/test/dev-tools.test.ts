import { randomUUID } from "node:crypto";
import { schema } from "@fs/db";
import { devStateSchema, profileViewSchema } from "@fs/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const {
  author,
  contentItem,
  discoveryQuery,
  discoveryRun,
  discoverySearch,
  interaction,
  letter,
  letterItem,
  profile,
  profileImport,
  publisher,
  review,
  schedule,
  session,
  source,
  topicWeight,
  user,
  userAuthor,
  userDiscovery,
  userPublisher,
  userSource,
} = schema;

const ctx = createTestApp({ devSignIn: true });
const remote = createTestApp();

// Shared rows this file creates; other suites (onboarding's picks) read every item, so they're removed after.
const created = { items: [] as string[], sources: [] as string[], publishers: [] as string[], authors: [] as string[], searches: [] as string[] };
afterAll(async () => {
  await ctx.db.delete(userSource).where(inArray(userSource.sourceId, created.sources));
  await ctx.db.delete(contentItem).where(inArray(contentItem.id, created.items));
  await ctx.db.delete(source).where(inArray(source.id, created.sources));
  await ctx.db.delete(publisher).where(inArray(publisher.id, created.publishers));
  await ctx.db.delete(author).where(inArray(author.id, created.authors));
  await ctx.db.delete(discoverySearch).where(inArray(discoverySearch.id, created.searches));
  await ctx.pool.end();
  await remote.pool.end();
});

const idOf = async (email: string) => (await ctx.db.select().from(user).where(eq(user.email, email)))[0]!.id;

const call = (app: typeof ctx, method: string, path: string, cookie?: string, body?: unknown) =>
  app.app.request(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A followed source with one item, and everything a user collects around it: what a real account accumulates. */
async function seedUser(userId: string) {
  const key = `${randomUUID().slice(0, 8)}.test`;
  const [p] = await ctx.db.insert(publisher).values({ key, name: key, origin: "user_added" }).returning();
  const [s] = await ctx.db
    .insert(source)
    .values({ canonicalKey: `https://${key}/feed`, type: "feed", publisherId: p!.id, title: key, inputUrl: `https://${key}/`, fetchUrl: `https://${key}/feed`, nextFetchAt: new Date("2030-01-01T00:00:00Z") })
    .returning();
  const [item] = await ctx.db
    .insert(contentItem)
    .values({ canonicalUrl: `https://${key}/a`, type: "article", sourceId: s!.id, publisherId: p!.id, title: "Pricing for clinics", status: "extracted" })
    .returning();
  const [found] = await ctx.db.insert(contentItem).values({ canonicalUrl: `https://${key}/found`, type: "article", publisherId: p!.id }).returning();
  const [a] = await ctx.db.insert(author).values({ key: `${key}:dana`, name: "Dana", initials: "D" }).returning();
  const [search] = await ctx.db
    .insert(discoverySearch)
    .values({ normalizedQuery: `pricing ${key}`, queryText: "pricing", method: "fake", model: "fake", promptVersion: "t", expiresAt: new Date("2030-01-01T00:00:00Z") })
    .returning();
  created.publishers.push(p!.id);
  created.sources.push(s!.id);
  created.items.push(item!.id, found!.id);
  created.authors.push(a!.id);
  created.searches.push(search!.id);

  const [imp] = await ctx.db
    .insert(profileImport)
    .values({ userId, assistant: "claude", rawText: "x".repeat(500), result: { facts: [], dropped: [] }, method: "parser" })
    .returning();
  await ctx.db.insert(profile).values({ userId, role: "founder", lately: "clinic pricing", importId: imp!.id, onboardedAt: new Date() });
  await ctx.db.insert(topicWeight).values({ userId, topic: "pricing", origin: "explicit" });
  await ctx.db.insert(schedule).values({ userId, weekdays: [1, 2, 3, 4, 5], localTime: "07:30", timeZone: "UTC", nextRunAt: new Date("2030-01-07T07:30:00Z") });
  await ctx.db.insert(userSource).values({ userId, sourceId: s!.id });
  await ctx.db.insert(userAuthor).values({ userId, authorId: a!.id });
  await ctx.db.insert(userPublisher).values({ userId, publisherId: p!.id });
  await ctx.db.insert(review).values({ userId, itemId: item!.id, vote: "interested", origin: "in_app" });
  const [l] = await ctx.db
    .insert(letter)
    .values({ userId, occurrenceId: `test#${randomUUID()}`, isTest: true, status: "sent", number: 1, scheduledFor: new Date(), deliveredAt: new Date(), localDate: "2026-10-01" })
    .returning();
  await ctx.db.insert(letterItem).values({
    letterId: l!.id,
    itemId: item!.id,
    position: 0,
    feedbackCode: "A1",
    snapshot: { kind: "article", title: "Pricing for clinics", topic: "Pricing", minutes: 4, whyPicked: null, summary: "", tag: null, sourceName: key, originalUrl: item!.canonicalUrl, image: null, author: null, evidenceIds: [], profileVersion: 1 },
  });
  await ctx.db.insert(interaction).values([
    { eventId: randomUUID(), userId, itemId: item!.id, letterId: l!.id, type: "open", occurredAt: new Date(), localDay: "2026-10-01" },
    // Saved from the library: not tied to a letter.
    { eventId: randomUUID(), userId, itemId: found!.id, letterId: null, type: "save", occurredAt: new Date(), localDay: "2026-10-01" },
  ]);
  const [run] = await ctx.db.insert(discoveryRun).values({ userId, occurrenceId: `dev#${randomUUID()}`, letterDueAt: new Date(), status: "done", itemsLinked: 1 }).returning();
  const [q] = await ctx.db
    .insert(discoveryQuery)
    .values({ runId: run!.id, userId, position: 0, queryText: "clinic pricing", normalizedQuery: "clinic pricing", origin: "lately", inputsHash: "h", method: "fake", promptVersion: "t", status: "searched", searchId: search!.id, resultCount: 1, acceptedCount: 1 })
    .returning();
  await ctx.db.insert(userDiscovery).values({ userId, itemId: found!.id, queryId: q!.id, reason: "About clinic pricing" });
  return { publisherId: p!.id, sourceId: s!.id, itemId: item!.id, foundId: found!.id, authorId: a!.id, searchId: search!.id, letterId: l!.id, runId: run!.id };
}

type Seeded = Awaited<ReturnType<typeof seedUser>>;

let cookie: string;
let userId: string;
let otherCookie: string;
let otherId: string;
let mine: Seeded;
let theirs: Seeded;
beforeAll(async () => {
  cookie = await signIn(ctx, "devtools@example.com");
  userId = await idOf("devtools@example.com");
  otherCookie = await signIn(ctx, "devtools-other@example.com");
  otherId = await idOf("devtools-other@example.com");
});

const PATHS: [string, string][] = [
  ["GET", "/dev/state"],
  ["POST", "/dev/onboarding/restart"],
  ["POST", "/dev/reset"],
  ["POST", "/dev/discovery"],
  ["POST", "/dev/letter"],
  ["POST", "/dev/letters/forget"],
  ["POST", "/dev/sources/refresh"],
];

describe("dev tools: guard", () => {
  it("don't exist unless the API is local, even when signed in", async () => {
    const remoteCookie = await signIn(remote, "devtools-remote@example.com");
    for (const [method, path] of PATHS) {
      const res = await call(remote, method, path, remoteCookie, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("need a signed-in user", async () => {
    for (const [method, path] of PATHS) {
      const res = await call(ctx, method, path, undefined, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("leave the sign-in shortcut working without a session", async () => {
    const res = await ctx.app.request(`${BASE_URL}/dev/sign-in-code`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("dev tools: mock accounts", () => {
  const mock = `devtools-${randomUUID().slice(0, 8)}@founder-signal.local`;
  afterAll(async () => {
    await ctx.db.delete(user).where(eq(user.email, mock));
  });

  it("signs in as a mock account, and only those", async () => {
    const ok = await call(ctx, "POST", "/dev/sign-in-code", undefined, { email: mock.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ email: mock, otp: expect.any(String) });

    for (const email of ["someone@example.com", "dev@founder-signal.local.evil.com", "not-an-email"]) {
      const res = await call(ctx, "POST", "/dev/sign-in-code", undefined, { email });
      expect(res.status, email).toBe(400);
    }
    const remoteRes = await call(remote, "POST", "/dev/sign-in-code", undefined, { email: mock });
    expect(remoteRes.status).toBe(404);
  });

  it("lists the mock accounts and nobody else, only locally", async () => {
    await signIn(ctx, mock);
    await signIn(ctx, "devtools-outsider@example.com");
    const res = await call(ctx, "GET", "/dev/accounts");
    expect(res.status).toBe(200);
    const { accounts } = (await res.json()) as { accounts: { email: string }[] };
    expect(accounts.map((a) => a.email)).toContain(mock);
    expect(accounts.every((a) => a.email.endsWith("@founder-signal.local"))).toBe(true);
    expect((await call(remote, "GET", "/dev/accounts")).status).toBe(404);
  });
});

describe("dev tools: state and actions", () => {
  beforeAll(async () => {
    mine = await seedUser(userId);
    theirs = await seedUser(otherId);
  });

  it("reports the user's own state", async () => {
    const res = await call(ctx, "GET", "/dev/state", cookie);
    expect(res.status).toBe(200);
    const { state } = (await res.json()) as { state: unknown };
    const s = devStateSchema.parse(state);
    expect(s.user).toEqual({ id: userId, email: "devtools@example.com" });
    expect(s.profile).toMatchObject({ role: "founder", lately: "clinic pricing", topics: [{ topic: "pricing", origin: "explicit", weight: 1 }] });
    expect(s.latestImport?.excerpt).toHaveLength(200);
    expect(s.schedule).toMatchObject({ localTime: "07:30", paused: false, skipNext: false });
    expect(s.counts).toEqual({ followedSources: 1, sourceItems: { extracted: 1 }, discoveredItems: 1, reviews: 1, interactions: 2, letters: 1 });
    expect(s.letters).toEqual([expect.objectContaining({ id: mine.letterId, status: "sent", pieceCount: 1, waitingOnDiscovery: false })]);
    expect(s.discoveryRuns).toHaveLength(1);
    expect(s.discoveryRuns[0]!.queries[0]).toMatchObject({ text: "clinic pricing", status: "searched", resultCount: 1, acceptedCount: 1 });
    expect(s.discoveryRuns[0]!.queries[0]!.found).toEqual([expect.objectContaining({ itemId: mine.foundId, status: "pending", title: expect.stringContaining("/found") })]);
  });

  it("restarts onboarding, keeping the answers", async () => {
    const res = await call(ctx, "POST", "/dev/onboarding/restart", cookie);
    expect(res.status).toBe(200);
    const { profile: view } = (await res.json()) as { profile: unknown };
    expect(profileViewSchema.parse(view)).toMatchObject({ onboardedAt: null, role: "founder", lately: "clinic pricing", topics: ["pricing"] });
    const [theirProfile] = await ctx.db.select().from(profile).where(eq(profile.userId, otherId));
    expect(theirProfile!.onboardedAt).not.toBeNull();
  });

  it("lets finishing onboarding again send a fresh first letter", async () => {
    const firstOf = async () =>
      (await ctx.db.select({ id: letter.id }).from(letter).where(and(eq(letter.userId, userId), eq(letter.occurrenceId, "first"))))[0]?.id;
    expect((await call(ctx, "POST", "/me/onboarding/complete", cookie)).status).toBe(200);
    const before = await firstOf();
    expect(before).toBeDefined();
    expect((await call(ctx, "POST", "/dev/onboarding/restart", cookie)).status).toBe(200);
    expect(await firstOf()).toBeUndefined();
    expect((await call(ctx, "POST", "/me/onboarding/complete", cookie)).status).toBe(200);
    const after = await firstOf();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("starts a discovery run for the dev runner", async () => {
    const res = await call(ctx, "POST", "/dev/discovery", cookie);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const [run] = await ctx.db.select().from(discoveryRun).where(eq(discoveryRun.id, runId));
    expect(run).toMatchObject({ userId, status: "pending" });
    expect(run!.occurrenceId).toMatch(/^dev#/);
  });

  it("makes test letters without the rate limit", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await call(ctx, "POST", "/dev/letter", cookie, {});
      expect(res.status).toBe(202);
      const { letterId, runId } = (await res.json()) as { letterId: string; runId: string | null };
      expect(runId).toBeNull();
      const [l] = await ctx.db.select().from(letter).where(eq(letter.id, letterId));
      expect(l).toMatchObject({ userId, isTest: true, status: "scheduled" });
      expect(l!.watchdogAt).not.toBeNull();
    }
  });

  it("holds a discover-first letter until its run ends", async () => {
    const res = await call(ctx, "POST", "/dev/letter", cookie, { discoverFirst: true });
    expect(res.status).toBe(202);
    const { letterId, runId } = (await res.json()) as { letterId: string; runId: string };
    const [l] = await ctx.db.select().from(letter).where(eq(letter.id, letterId));
    const [run] = await ctx.db.select().from(discoveryRun).where(eq(discoveryRun.id, runId));
    expect(l!.watchdogAt).toBeNull();
    expect(run!.status).toBe("pending");
    // Paired by occurrence: test#<id> waits on dev#<id>.
    expect(l!.occurrenceId.slice("test#".length)).toBe(run!.occurrenceId.slice("dev#".length));

    const state = devStateSchema.parse(((await (await call(ctx, "GET", "/dev/state", cookie)).json()) as { state: unknown }).state);
    expect(state.letters.find((x) => x.id === letterId)?.waitingOnDiscovery).toBe(true);
  });

  it("validates bodies", async () => {
    expect((await call(ctx, "POST", "/dev/letter", cookie, { discoverFirst: "yes" })).status).toBe(400);
    expect((await call(ctx, "POST", "/dev/letters/forget", cookie, { includeReviews: 1 })).status).toBe(400);
  });

  it("makes the user's followed sources due, and only theirs", async () => {
    const res = await call(ctx, "POST", "/dev/sources/refresh", cookie);
    expect(await res.json()).toEqual({ sources: 1 });
    const [s] = await ctx.db.select().from(source).where(eq(source.id, mine.sourceId));
    const [other] = await ctx.db.select().from(source).where(eq(source.id, theirs.sourceId));
    expect(s!.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(other!.nextFetchAt!.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("forgets letters and their events, keeping reviews unless asked", async () => {
    const res = await call(ctx, "POST", "/dev/letters/forget", cookie, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: 1, interactions: 1, reviews: 0 });
    expect(await ctx.db.select().from(letter).where(eq(letter.userId, userId))).toEqual([]);
    expect(await ctx.db.select().from(letterItem).where(eq(letterItem.letterId, mine.letterId))).toEqual([]);
    // The library save (no letter) stays, and so does the review.
    expect(await ctx.db.select().from(interaction).where(eq(interaction.userId, userId))).toHaveLength(1);
    expect(await ctx.db.select().from(review).where(eq(review.userId, userId))).toHaveLength(1);

    const again = await call(ctx, "POST", "/dev/letters/forget", cookie, { includeReviews: true });
    expect(await again.json()).toEqual({ letters: 0, items: 0, interactions: 0, reviews: 1 });
    expect(await ctx.db.select().from(review).where(eq(review.userId, userId))).toEqual([]);

    // The other user's letters are untouched.
    expect(await ctx.db.select().from(letter).where(eq(letter.userId, otherId))).toHaveLength(1);
  });

  it("resets the user to a brand-new account, keeping sign-in and shared rows", async () => {
    const res = await call(ctx, "POST", "/dev/reset", cookie);
    expect(res.status).toBe(200);
    const { profile: view } = (await res.json()) as { profile: unknown };
    expect(profileViewSchema.parse(view)).toMatchObject({ role: null, topics: [], schedule: null, onboardedAt: null });

    const perUser = { profile, profileImport, topicWeight, schedule, review, userSource, userAuthor, userPublisher, userDiscovery, discoveryRun, discoveryQuery, letter, interaction };
    for (const [name, table] of Object.entries(perUser)) {
      const rows = await ctx.db.execute(sql`select 1 from ${table} where user_id = ${userId}`);
      expect(rows.rows, name).toHaveLength(0);
    }

    // The auth user and session stay: the same cookie still works.
    expect(await ctx.db.select().from(user).where(eq(user.id, userId))).toHaveLength(1);
    expect(await ctx.db.select().from(session).where(eq(session.userId, userId))).not.toHaveLength(0);
    const me = await call(ctx, "GET", "/me", cookie);
    expect(me.status).toBe(200);

    // Shared rows are untouched.
    expect(await ctx.db.select().from(publisher).where(eq(publisher.id, mine.publisherId))).toHaveLength(1);
    expect(await ctx.db.select().from(source).where(eq(source.id, mine.sourceId))).toHaveLength(1);
    expect(await ctx.db.select().from(contentItem).where(inArray(contentItem.id, [mine.itemId, mine.foundId]))).toHaveLength(2);
    expect(await ctx.db.select().from(author).where(eq(author.id, mine.authorId))).toHaveLength(1);
    expect(await ctx.db.select().from(discoverySearch).where(eq(discoverySearch.id, mine.searchId))).toHaveLength(1);

    // The other user's data is untouched.
    expect(await ctx.db.select().from(profile).where(eq(profile.userId, otherId))).toHaveLength(1);
    expect(await ctx.db.select().from(userDiscovery).where(eq(userDiscovery.userId, otherId))).toHaveLength(1);
    expect(await ctx.db.select().from(review).where(eq(review.userId, otherId))).toHaveLength(1);
    const theirState = await call(ctx, "GET", "/dev/state", otherCookie);
    expect(devStateSchema.parse(((await theirState.json()) as { state: unknown }).state).counts.letters).toBe(1);
  });
});
