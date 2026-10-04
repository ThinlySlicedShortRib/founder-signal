import { FIRST_LETTER_OCCURRENCE, localDateOf } from "@fs/core";
import { type Db, schema } from "@fs/db";
import {
  DEV_ACCOUNT_DOMAIN,
  type DevAccount,
  devSignInInputSchema,
  DEV_RUN_PREFIX,
  type DevDiscoveryRun,
  devForgetLettersInputSchema,
  type DevLetter,
  devLetterInputSchema,
  type DevState,
  TEST_LETTER_PREFIX,
} from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "../auth.ts";
import { apiError } from "../lib/errors.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";
import { loadProfileView } from "./profile.ts";

const {
  contentItem,
  discoveryQuery,
  discoveryRun,
  interaction,
  letter,
  letterItem,
  profile,
  profileImport,
  publisher,
  review,
  schedule,
  source,
  topicWeight,
  user: authUser,
  userAuthor,
  userDiscovery,
  userPublisher,
  userSource,
} = schema;

/** The account the app's "Skip sign-in (dev)" button uses. */
export const DEV_USER_EMAIL = "dev@founder-signal.local";

/** Remembers the latest code sent to each address (local development only). */
export function createOtpRecorder() {
  const latest = new Map<string, string>();
  return {
    record: (email: string, otp: string) => void latest.set(email.toLowerCase(), otp),
    take: (email: string) => {
      const otp = latest.get(email.toLowerCase());
      latest.delete(email.toLowerCase());
      return otp;
    },
  };
}

export type OtpRecorder = ReturnType<typeof createOtpRecorder>;

/**
 * Local development only, never mounted on AWS: sends a sign-in code for the
 * dev account or one of the local mock accounts (`@founder-signal.local`)
 * and returns it, so the app can sign in through the normal email-code flow
 * without anyone reading the API log. No other address is accepted.
 */
export function devRoutes({ auth, otps, db }: { auth: Auth; otps: OtpRecorder; db: Db }) {
  return new Hono()
    .post("/sign-in-code", async (c) => {
      // The body is optional: no body signs in as the dev account.
      const raw = c.req.header("content-type")?.includes("application/json") ? await c.req.json().catch(() => null) : {};
      const parsed = devSignInInputSchema.safeParse(raw ?? {});
      if (!parsed.success) return apiError(c, 400, "VALIDATION_FAILED", `Only ${DEV_ACCOUNT_DOMAIN} accounts can use dev sign-in`);
      const email = parsed.data.email ?? DEV_USER_EMAIL;
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
      const otp = otps.take(email);
      if (!otp) return apiError(c, 500, "INTERNAL", "No code was generated");
      return c.json({ email, otp });
    })

    /** The local mock accounts, for the Dev tools account switcher. */
    .get("/accounts", async (c) => {
      const rows = await db
        .select({ email: authUser.email, name: authUser.name, role: profile.role, onboardedAt: profile.onboardedAt })
        .from(authUser)
        .leftJoin(profile, eq(profile.userId, authUser.id))
        .where(sql`${authUser.email} like ${`%${DEV_ACCOUNT_DOMAIN}`}`)
        .orderBy(authUser.email);
      const accounts: DevAccount[] = rows.map((r) => ({ email: r.email, name: r.name, role: r.role, onboarded: !!r.onboardedAt }));
      return c.json({ accounts });
    });
}

// ── Dev tools (the app's Dev tools screen) ──────────────────────────────────

const RECENT_LETTERS = 5;
const RECENT_RUNS = 3;
const IMPORT_EXCERPT = 200;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Local development only, like /dev/sign-in-code: the Dev tools screen's
 * snapshot and its actions. Every route acts on the signed-in user's own
 * rows; shared tables (publishers, sources, items, the search cache) are
 * never changed, except a followed source's next fetch time. The local
 * workers can't be reached from here, so work is asked for through the
 * database and the dev runner (apps/workers/src/dev.ts) picks it up.
 */
export function devToolRoutes({ db }: { db: Db }) {
  return new Hono<AuthedEnv>()
    .use(requireUser)

    .get("/state", async (c) => {
      const user = c.get("user");
      return c.json({ state: await loadDevState(db, { id: user.id, email: user.email }) });
    })

    // The app shows onboarding while `onboardedAt` is null; everything else stays, so its answers are filled in.
    .post("/onboarding/restart", async (c) => {
      const userId = c.get("user").id;
      await db.transaction(async (tx) => {
        await tx.update(profile).set({ onboardedAt: null }).where(eq(profile.userId, userId));
        // Finishing again sends a fresh first letter: there's only ever one per user, so the old one goes.
        const first = and(eq(letter.userId, userId), eq(letter.occurrenceId, FIRST_LETTER_OCCURRENCE));
        await tx.delete(interaction).where(inArray(interaction.letterId, tx.select({ id: letter.id }).from(letter).where(first)));
        await tx.delete(letter).where(first);
        await tx.delete(discoveryRun).where(and(eq(discoveryRun.userId, userId), eq(discoveryRun.occurrenceId, FIRST_LETTER_OCCURRENCE)));
      });
      return c.json({ profile: await loadProfileView(db, userId) });
    })

    // Back to a brand-new account: the auth user and session stay, the user's own app data goes.
    .post("/reset", async (c) => {
      const userId = c.get("user").id;
      await db.transaction(async (tx) => {
        await tx.delete(interaction).where(eq(interaction.userId, userId));
        // Letter items go with their letters (cascade).
        await tx.delete(letter).where(eq(letter.userId, userId));
        await tx.delete(userDiscovery).where(eq(userDiscovery.userId, userId));
        await tx.delete(discoveryQuery).where(eq(discoveryQuery.userId, userId));
        await tx.delete(discoveryRun).where(eq(discoveryRun.userId, userId));
        await tx.delete(review).where(eq(review.userId, userId));
        await tx.delete(userAuthor).where(eq(userAuthor.userId, userId));
        await tx.delete(userPublisher).where(eq(userPublisher.userId, userId));
        await tx.delete(userSource).where(eq(userSource.userId, userId));
        await tx.delete(topicWeight).where(eq(topicWeight.userId, userId));
        await tx.delete(schedule).where(eq(schedule.userId, userId));
        await tx.delete(profile).where(eq(profile.userId, userId));
        await tx.delete(profileImport).where(eq(profileImport.userId, userId));
      });
      return c.json({ profile: await loadProfileView(db, userId) });
    })

    // Not queued: the dev runner runs pending `dev#` runs itself.
    .post("/discovery", async (c) => {
      const [run] = await db
        .insert(discoveryRun)
        .values({ userId: c.get("user").id, occurrenceId: `${DEV_RUN_PREFIX}${crypto.randomUUID()}`, letterDueAt: new Date() })
        .returning({ id: discoveryRun.id });
      return c.json({ runId: run!.id }, 202);
    })

    // A test letter without the rate limit. With `discoverFirst`, it's held (no watchdog time)
    // until its `dev#` run ends; the dev runner then sets the watchdog and the letter sweep starts it.
    .post(
      "/letter",
      zValidator("json", devLetterInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send discoverFirst: true or false");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { discoverFirst = false } = c.req.valid("json");
        const [s] = await db.select({ timeZone: schedule.timeZone }).from(schedule).where(eq(schedule.userId, userId));
        const now = new Date();
        const id = crypto.randomUUID();
        const out = await db.transaction(async (tx) => {
          const [run] = discoverFirst
            ? await tx.insert(discoveryRun).values({ userId, occurrenceId: `${DEV_RUN_PREFIX}${id}`, letterDueAt: now }).returning({ id: discoveryRun.id })
            : [];
          const [row] = await tx
            .insert(letter)
            .values({
              userId,
              occurrenceId: `${TEST_LETTER_PREFIX}${id}`,
              isTest: true,
              scheduledFor: now,
              localDate: localDateOf(now, s?.timeZone ?? "UTC"),
              watchdogAt: discoverFirst ? null : now,
            })
            .returning({ id: letter.id });
          return { letterId: row!.id, runId: run?.id ?? null };
        });
        return c.json(out, 202);
      },
    )

    // Previously delivered pieces become candidates again: letters (and their items and events) go,
    // reviews too when asked, since collect also leaves out anything reviewed.
    .post(
      "/letters/forget",
      zValidator("json", devForgetLettersInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send includeReviews: true or false");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { includeReviews = false } = c.req.valid("json");
        const counts = await db.transaction(async (tx) => {
          const own = tx.select({ id: letter.id }).from(letter).where(eq(letter.userId, userId));
          const events = await tx
            .delete(interaction)
            .where(and(eq(interaction.userId, userId), inArray(interaction.letterId, own)))
            .returning({ id: interaction.id });
          const [items] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(letterItem)
            .where(inArray(letterItem.letterId, own));
          const letters = await tx.delete(letter).where(eq(letter.userId, userId)).returning({ id: letter.id });
          const reviews = includeReviews ? await tx.delete(review).where(eq(review.userId, userId)).returning({ id: review.id }) : [];
          return { letters: letters.length, items: items?.n ?? 0, interactions: events.length, reviews: reviews.length };
        });
        return c.json(counts);
      },
    )

    // Due now: the dev runner sweeps as soon as a followed source is due, rather than at its next minute.
    .post("/sources/refresh", async (c) => {
      const userId = c.get("user").id;
      const followed = db
        .select({ id: userSource.sourceId })
        .from(userSource)
        .where(and(eq(userSource.userId, userId), eq(userSource.blocked, false)));
      // One-off URL sources (no next fetch) were ingested once and aren't polled again.
      const rows = await db
        .update(source)
        .set({ nextFetchAt: sql`now()` })
        .where(and(inArray(source.id, followed), isNotNull(source.nextFetchAt)))
        .returning({ id: source.id });
      return c.json({ sources: rows.length });
    });
}

async function loadDevState(db: Db, user: { id: string; email: string }): Promise<DevState> {
  const userId = user.id;
  const followedIds = db
    .select({ id: userSource.sourceId })
    .from(userSource)
    .where(and(eq(userSource.userId, userId), eq(userSource.blocked, false)));

  const [[p], topics, [imp], [s], [followed], sourceItems, counts, letters, runs, [activity]] = await Promise.all([
    db.select().from(profile).where(eq(profile.userId, userId)),
    db
      .select({ topic: topicWeight.topic, origin: topicWeight.origin, weight: topicWeight.weight })
      .from(topicWeight)
      .where(eq(topicWeight.userId, userId))
      .orderBy(desc(topicWeight.weight), topicWeight.topic),
    db
      .select({
        assistant: profileImport.assistant,
        createdAt: profileImport.createdAt,
        method: profileImport.method,
        model: profileImport.model,
        excerpt: sql<string>`left(${profileImport.rawText}, ${IMPORT_EXCERPT})`,
      })
      .from(profileImport)
      .where(eq(profileImport.userId, userId))
      .orderBy(desc(profileImport.createdAt))
      .limit(1),
    db.select().from(schedule).where(eq(schedule.userId, userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(userSource).where(and(eq(userSource.userId, userId), eq(userSource.blocked, false))),
    db
      .select({ status: contentItem.status, n: sql<number>`count(*)::int` })
      .from(contentItem)
      .where(inArray(contentItem.sourceId, followedIds))
      .groupBy(contentItem.status),
    db.execute<{ discovered: number; reviews: number; interactions: number; letters: number }>(sql`
      select
        (select count(*)::int from ${userDiscovery} where user_id = ${userId}) as discovered,
        (select count(*)::int from ${review} where user_id = ${userId}) as reviews,
        (select count(*)::int from ${interaction} where user_id = ${userId}) as interactions,
        (select count(*)::int from ${letter} where user_id = ${userId}) as letters`),
    db
      .select({
        id: letter.id,
        number: letter.number,
        status: letter.status,
        isTest: letter.isTest,
        occurrenceId: letter.occurrenceId,
        watchdogAt: letter.watchdogAt,
        createdAt: letter.createdAt,
        deliveredAt: letter.deliveredAt,
        failureReason: letter.failureReason,
        generation: letter.generationMeta,
        // Spelled out: Drizzle leaves columns unqualified in a single-table select, which a subquery would misread.
        pieceCount: sql<number>`(select count(*)::int from letter_item li where li.letter_id = "letter"."id")`,
      })
      .from(letter)
      .where(eq(letter.userId, userId))
      .orderBy(desc(letter.createdAt))
      .limit(RECENT_LETTERS),
    db.select().from(discoveryRun).where(eq(discoveryRun.userId, userId)).orderBy(desc(discoveryRun.createdAt)).limit(RECENT_RUNS),
    // Anything a worker last did for this user: moved a letter, ran discovery, fetched a followed source.
    db.execute<{ at: Date | null }>(sql`
      select greatest(
        (select max(updated_at) from ${letter} where user_id = ${userId} and status <> 'scheduled'),
        (select max(greatest(started_at, finished_at)) from ${discoveryRun} where user_id = ${userId}),
        (select max(s.last_fetched_at) from ${source} s join ${userSource} us on us.source_id = s.id where us.user_id = ${userId})
      ) as at`).then((r) => r.rows),
  ]);

  // Discovery runs' queries and the pages each one linked.
  const runIds = runs.map((r) => r.id);
  const queries = runIds.length
    ? await db.select().from(discoveryQuery).where(inArray(discoveryQuery.runId, runIds)).orderBy(discoveryQuery.position)
    : [];
  const queryIds = queries.map((q) => q.id);
  const found = queryIds.length
    ? await db
        .select({
          queryId: userDiscovery.queryId,
          itemId: contentItem.id,
          title: contentItem.title,
          url: contentItem.canonicalUrl,
          publisher: publisher.name,
          status: contentItem.status,
          statusReason: contentItem.statusReason,
        })
        .from(userDiscovery)
        .innerJoin(contentItem, eq(contentItem.id, userDiscovery.itemId))
        .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
        .where(and(eq(userDiscovery.userId, userId), inArray(userDiscovery.queryId, queryIds)))
        .orderBy(userDiscovery.foundAt)
    : [];

  const discoveryRuns: DevDiscoveryRun[] = runs.map((r) => ({
    id: r.id,
    occurrenceId: r.occurrenceId,
    status: r.status,
    queryMethod: r.queryMethod,
    queriesGenerated: r.queriesGenerated,
    searchesRun: r.searchesRun,
    cacheHits: r.cacheHits,
    itemsLinked: r.itemsLinked,
    itemsQueued: r.itemsQueued,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    queries: queries
      .filter((q) => q.runId === r.id)
      .map((q) => ({
        id: q.id,
        text: q.queryText,
        origin: q.origin,
        status: q.status,
        resultCount: q.resultCount,
        acceptedCount: q.acceptedCount,
        found: found
          .filter((f) => f.queryId === q.id)
          .map((f) => ({ itemId: f.itemId, title: f.title ?? f.url, url: f.url, publisher: f.publisher, status: f.status, statusReason: f.statusReason })),
      })),
  }));

  const recent: DevLetter[] = letters.map((l) => ({
    id: l.id,
    number: l.number,
    status: l.status,
    isTest: l.isTest,
    createdAt: l.createdAt.toISOString(),
    deliveredAt: iso(l.deliveredAt),
    failureReason: l.failureReason,
    pieceCount: l.pieceCount,
    generation: l.generation ? { method: l.generation.method, model: l.generation.model } : null,
    waitingOnDiscovery: l.status === "scheduled" && !l.watchdogAt && l.occurrenceId.startsWith(TEST_LETTER_PREFIX),
  }));

  const n = counts.rows[0]!;
  return {
    user,
    profile: p
      ? { role: p.role, lately: p.lately, onboardedAt: iso(p.onboardedAt), version: p.version, topics }
      : null,
    latestImport: imp ? { assistant: imp.assistant, createdAt: imp.createdAt.toISOString(), method: imp.method, model: imp.model, excerpt: imp.excerpt } : null,
    schedule: s
      ? {
          preset: s.preset,
          weekdays: s.weekdays,
          localTime: s.localTime,
          timeZone: s.timeZone,
          paused: s.paused,
          skipNext: s.skipNext,
          nextRunAt: iso(s.nextRunAt),
        }
      : null,
    counts: {
      followedSources: followed?.n ?? 0,
      sourceItems: Object.fromEntries(sourceItems.map((r) => [r.status, r.n])),
      discoveredItems: n.discovered,
      reviews: n.reviews,
      interactions: n.interactions,
      letters: n.letters,
    },
    letters: recent,
    discoveryRuns,
    lastWorkerActivityAt: activity?.at ? new Date(activity.at).toISOString() : null,
  };
}
