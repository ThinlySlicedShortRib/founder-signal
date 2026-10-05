import { discoveryInputHash, type FoundPage } from "@fs/ai";
import {
  acceptableResults,
  blockedDomainsFor,
  type DiscoveryBrief,
  fallbackQueries,
  type GeneratedQuery,
  GLOBAL_BLOCKED_DOMAINS,
  localDateOf,
  MAX_LINKS_PER_RUN,
  type QueryDecision,
  SEARCH_CACHE_TTL_DAYS,
  selectQueries,
  STALE_QUERY_DAYS,
} from "@fs/core";
import { type Db, schema } from "@fs/db";
import type { DiscoveryResult } from "@fs/db/schema";
import { canonicalizeUrl, publisherKeyForUrl } from "@fs/ingest";
import { and, eq, gt, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { loadUserContext } from "../letters/context.ts";
import { failHeldRun, releaseHeldLetters, runHoldsLetter } from "../letters/held.ts";
import { ASSEMBLY_LEAD_MINUTES } from "../letters/sweep.ts";
import { type Discovery, logger, type PipelineDeps } from "../pipeline/deps.ts";
import type { Message } from "../pipeline/messages.ts";
import { globallyBlockedKeys, refreshUserPublisherBlocks } from "./catalog.ts";

const { contentItem, discoveryQuery, discoveryRun, discoverySearch, publisher, schedule, userDiscovery } = schema;

/** A `running` run older than this belongs to a worker that died; it can be claimed again. */
const RUN_LEASE_MINUTES = 15;
const MAX_RUNS_PER_SWEEP = 100;
/** No letter excludes a user, but `loadUserContext` wants one to leave out. */
const NO_LETTER = "00000000-0000-0000-0000-000000000000";

// ── Starting runs (from the sweep) ──────────────────────────────────────────

/**
 * Discovery for each due letter (§6.3a.6): schedules whose next letter is
 * within DISCOVERY_LEAD_HOURS but not yet being assembled get one run per
 * occurrence (`(user_id, occurrence_id)` is unique, so overlapping sweeps
 * start it once). A skipped or paused occurrence gets none.
 */
export async function startDueDiscovery(deps: PipelineDeps, { leadHours }: { leadHours: number }): Promise<number> {
  if (!deps.discovery) return 0;
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await db
    .select({ userId: schedule.userId, nextRunAt: schedule.nextRunAt, timeZone: schedule.timeZone, version: schedule.version })
    .from(schedule)
    .where(
      and(
        isNotNull(schedule.nextRunAt),
        eq(schedule.paused, false),
        eq(schedule.skipNext, false),
        sql`${schedule.nextRunAt} - make_interval(hours => ${leadHours}) <= ${now}`,
        sql`${schedule.nextRunAt} - make_interval(mins => ${ASSEMBLY_LEAD_MINUTES}) > ${now}`,
      ),
    )
    .orderBy(schedule.nextRunAt)
    .limit(MAX_RUNS_PER_SWEEP);

  let started = 0;
  for (const s of due) {
    const runAt = s.nextRunAt!;
    // The same occurrence ID the letter will get (letters/sweep.ts).
    const occurrenceId = `${localDateOf(runAt, s.timeZone)}#${s.version}`;
    const [run] = await db
      .insert(discoveryRun)
      .values({ userId: s.userId, occurrenceId, letterDueAt: runAt })
      .onConflictDoNothing({ target: [discoveryRun.userId, discoveryRun.occurrenceId] })
      .returning({ id: discoveryRun.id });
    if (!run) continue;
    await deps.queues.send("discover", { runId: run.id });
    started++;
  }
  if (started) logger(deps)("discovery_scheduled", { count: started });
  return started;
}

// ── Running one (the discover worker) ───────────────────────────────────────

type Run = typeof discoveryRun.$inferSelect;

/**
 * One discovery run (§6.3a.1–4): the user's brief → queries (Haiku, or a
 * fallback from their topics) → up to MAX_QUERIES_PER_LETTER searches, each
 * served from the shared cache when it can be → acceptable pages linked to
 * the user, and new ones queued for normal extraction.
 */
export async function discover(deps: PipelineDeps, { runId }: Message<"discover">) {
  const log = logger(deps);
  if (!deps.discovery) return { status: "disabled" as const };
  const run = await claimRun(deps.db, runId);
  if (!run) return { status: "stale" as const };
  try {
    const result = await runDiscovery(deps, deps.discovery, run);
    log("discovery_run", { runId, userId: run.userId, ...result });
    // A letter waiting on this run may be able to start (if nothing it found still needs extracting).
    await releaseHeldLetters(deps);
    return { status: "done" as const, ...result };
  } catch (err) {
    // Someone is waiting on this one (letters/held.ts): no retries, their letter goes ahead with what there is.
    if (await runHoldsLetter(deps, runId)) {
      await failHeldRun(deps, runId, (err as Error).message);
      await releaseHeldLetters(deps);
      return { status: "failed" as const };
    }
    // Otherwise let the queue retry it: back to pending, with the error kept.
    await deps.db
      .update(discoveryRun)
      .set({ status: "pending", startedAt: null, error: (err as Error).message.slice(0, 500) })
      .where(eq(discoveryRun.id, runId));
    throw err;
  }
}

async function claimRun(db: Db, runId: string): Promise<Run | null> {
  const [run] = await db
    .update(discoveryRun)
    .set({ status: "running", startedAt: sql`now()` })
    .where(
      and(
        eq(discoveryRun.id, runId),
        or(
          eq(discoveryRun.status, "pending"),
          and(eq(discoveryRun.status, "running"), lt(discoveryRun.startedAt, sql`now() - make_interval(mins => ${RUN_LEASE_MINUTES})`)),
        ),
      ),
    )
    .returning();
  return run ?? null;
}

async function runDiscovery(deps: PipelineDeps, discovery: Discovery, run: Run) {
  const { db } = deps;
  const log = logger(deps);
  const now = deps.now?.() ?? new Date();

  const brief = await loadDiscoveryBrief(db, run.userId);
  if (!brief.lately && !brief.topics.length && !brief.leanings.length && !brief.facts.length && !brief.liked.length) {
    await finishRun(db, run.id, { error: "empty brief" });
    return { queries: 0, searches: 0, cacheHits: 0, linked: 0, queued: 0 };
  }

  // Blocks: content farms, publishers the catalog blocked, and the user's own.
  const [globalBlocked, userBlocked] = await Promise.all([globallyBlockedKeys(db), refreshUserPublisherBlocks(db, run.userId)]);
  const blockedDomains = blockedDomainsFor(globalBlocked, userBlocked);
  const allBlocked = [...GLOBAL_BLOCKED_DOMAINS, ...globalBlocked, ...userBlocked];

  // 1. Queries.
  const inputsHash = discoveryInputHash(brief);
  let generated: GeneratedQuery[] = [];
  let method = discovery.queries.method;
  let model: string | null = discovery.queries.model;
  let promptVersion = discovery.queries.promptVersion;
  try {
    generated = await discovery.queries.generate(brief);
  } catch (err) {
    log("discovery_queries_fallback", { runId: run.id, message: (err as Error).message });
  }
  if (!generated.length) {
    generated = fallbackQueries(brief);
    method = "fallback";
    model = null;
    promptVersion = "fallback-v1";
  }

  // A query whose search failed found nothing because it never ran, so it doesn't count as run (or stale).
  const history = await db
    .select({ normalizedQuery: discoveryQuery.normalizedQuery, ranAt: discoveryQuery.ranAt, acceptedCount: discoveryQuery.acceptedCount })
    .from(discoveryQuery)
    .where(
      and(
        eq(discoveryQuery.userId, run.userId),
        isNotNull(discoveryQuery.ranAt),
        ne(discoveryQuery.status, "failed"),
        gt(discoveryQuery.ranAt, sql`now() - make_interval(days => ${STALE_QUERY_DAYS})`),
      ),
    );
  const past = history.map((h) => ({ normalizedQuery: h.normalizedQuery, ranAt: h.ranAt!, acceptedCount: h.acceptedCount ?? 0 }));
  const decisions = selectQueries(generated, past, { now });

  // Every generated query is logged, including the skipped ones.
  const queryRows = decisions.length
    ? await db
        .insert(discoveryQuery)
        .values(
          decisions.map((d, position) => ({
            runId: run.id,
            position,
            userId: run.userId,
            queryText: d.query.text,
            normalizedQuery: d.normalized,
            origin: d.query.origin,
            originDetail: d.query.originDetail,
            inputsHash,
            method,
            model,
            promptVersion,
            status: statusFor(d.decision),
          })),
        )
        .returning({ id: discoveryQuery.id })
    : [];
  await db
    .update(discoveryRun)
    .set({ inputsHash, queryMethod: method, queryModel: model, queryPromptVersion: promptVersion, queriesGenerated: generated.length })
    .where(eq(discoveryRun.id, run.id));

  // 2–3. Search (or the cache), then link and queue.
  let searches = 0;
  let cacheHits = 0;
  let linked = 0;
  let queued = 0;
  for (const [i, d] of decisions.entries()) {
    if (d.decision !== "run") continue;
    const queryId = queryRows[i]!.id;

    const found = await searchOrCache(deps, discovery, d.query.text, d.normalized, blockedDomains);
    if (!found) {
      await db.update(discoveryQuery).set({ status: "failed", ranAt: sql`now()` }).where(eq(discoveryQuery.id, queryId));
      continue;
    }
    if (found.cached) cacheHits++;
    else searches += found.webSearches;

    const pages = acceptableResults(found.pages, allBlocked);
    let accepted = 0;
    for (const page of pages) {
      if (linked >= MAX_LINKS_PER_RUN) break;
      const outcome = await linkPage(deps, run.userId, queryId, page);
      if (outcome.linked) {
        accepted++;
        linked++;
      }
      if (outcome.queued) queued++;
    }
    await db
      .update(discoveryQuery)
      .set({ status: found.cached ? "cached" : "searched", searchId: found.searchId, resultCount: pages.length, acceptedCount: accepted, ranAt: sql`now()` })
      .where(eq(discoveryQuery.id, queryId));
  }

  await finishRun(db, run.id, { searchesRun: searches, cacheHits, itemsLinked: linked, itemsQueued: queued });
  return { queries: generated.length, method, searches, cacheHits, linked, queued };
}

const statusFor = (d: QueryDecision) => (d === "run" ? ("pending" as const) : d);

async function finishRun(db: Db, runId: string, patch: Partial<Pick<Run, "searchesRun" | "cacheHits" | "itemsLinked" | "itemsQueued" | "error">>) {
  await db
    .update(discoveryRun)
    .set({ ...patch, status: "done", finishedAt: sql`now()` })
    .where(eq(discoveryRun.id, runId));
}

/**
 * A query's results from the shared cache while it's fresh (any user's
 * search counts), otherwise from a new search, which is then cached. Null
 * when the search failed; the run carries on with its other queries.
 */
async function searchOrCache(
  deps: PipelineDeps,
  discovery: Discovery,
  queryText: string,
  normalized: string,
  blockedDomains: string[],
): Promise<{ pages: DiscoveryResult[]; searchId: string; cached: boolean; webSearches: number } | null> {
  const { db } = deps;
  const [hit] = await db
    .select({ id: discoverySearch.id, results: discoverySearch.results })
    .from(discoverySearch)
    .where(and(eq(discoverySearch.normalizedQuery, normalized), gt(discoverySearch.expiresAt, sql`now()`)));
  if (hit) return { pages: hit.results, searchId: hit.id, cached: true, webSearches: 0 };

  let pages: FoundPage[];
  let webSearches: number;
  try {
    ({ pages, webSearches } = await discovery.search.search({ query: queryText, blockedDomains }));
  } catch (err) {
    logger(deps)("discovery_search_failed", { query: queryText, message: (err as Error).message });
    return null;
  }
  const values = {
    queryText,
    results: pages,
    resultCount: pages.length,
    webSearches,
    method: discovery.search.method,
    model: discovery.search.model,
    promptVersion: discovery.search.promptVersion,
    searchedAt: sql`now()`,
    expiresAt: sql`now() + make_interval(days => ${SEARCH_CACHE_TTL_DAYS})`,
  };
  const [row] = await db
    .insert(discoverySearch)
    .values({ normalizedQuery: normalized, ...values })
    .onConflictDoUpdate({ target: discoverySearch.normalizedQuery, set: values })
    .returning({ id: discoverySearch.id });
  return { pages, searchId: row!.id, cached: false, webSearches };
}

/**
 * Links one found page to the user (§6.3a.3–4). Its publisher joins the
 * catalog as a `candidate` the first time its domain is seen; the page
 * becomes an ordinary `content_item` (deduplicated on its canonical URL) and,
 * if it's new, goes through normal extraction. The title is left for
 * extraction to read from the page: nothing from search results is shown.
 */
async function linkPage(deps: PipelineDeps, userId: string, queryId: string, page: DiscoveryResult): Promise<{ linked: boolean; queued: boolean }> {
  const { db } = deps;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(page.url);
  } catch {
    return { linked: false, queued: false };
  }
  const key = publisherKeyForUrl(canonicalUrl);

  await db.insert(publisher).values({ key, name: key, origin: "discovered", status: "candidate" }).onConflictDoNothing({ target: publisher.key });
  const [pub] = await db.select({ id: publisher.id, status: publisher.status }).from(publisher).where(eq(publisher.key, key));
  if (!pub || pub.status === "blocked") return { linked: false, queued: false };

  const [inserted] = await db
    .insert(contentItem)
    .values({ canonicalUrl, type: "article", publisherId: pub.id })
    .onConflictDoNothing({ target: contentItem.canonicalUrl })
    .returning({ id: contentItem.id });
  let itemId = inserted?.id;
  if (inserted) {
    await db.update(publisher).set({ itemsSeen: sql`${publisher.itemsSeen} + 1` }).where(eq(publisher.id, pub.id));
    await deps.queues.send("extract", { itemId: inserted.id });
  } else {
    const [existing] = await db.select({ id: contentItem.id }).from(contentItem).where(eq(contentItem.canonicalUrl, canonicalUrl));
    itemId = existing?.id;
  }
  if (!itemId) return { linked: false, queued: false };

  const [link] = await db
    .insert(userDiscovery)
    .values({ userId, itemId, queryId, reason: page.reason })
    .onConflictDoNothing({ target: [userDiscovery.userId, userDiscovery.itemId] })
    .returning({ id: userDiscovery.id });
  return { linked: !!link, queued: !!inserted };
}

/** What the query generator sees (§6.3a.1): the user's own words and votes, never their name or email. */
export async function loadDiscoveryBrief(db: Db, userId: string): Promise<DiscoveryBrief> {
  const ctx = await loadUserContext(db, userId, NO_LETTER);
  return {
    role: ctx.brief.role,
    lately: ctx.brief.lately,
    topics: ctx.brief.topics,
    facts: ctx.brief.facts,
    liked: ctx.rank.reviews
      .filter((r) => r.vote === "interested" && r.title)
      .slice(0, 10)
      .map((r) => ({ title: r.title!, tags: r.tags.slice(0, 4), reasons: r.reasons.slice(0, 5) })),
    leanings: ctx.brief.leanings,
  };
}
