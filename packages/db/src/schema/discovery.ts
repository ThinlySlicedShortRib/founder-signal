import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { contentItem, publisher } from "./ingestion.ts";

/**
 * Open web discovery (build plan §6.3a): per letter, a run generates search
 * queries from what the user told us, searches the web with them, and links
 * the pages it finds to the user. Found pages are ordinary `content_item`s
 * (same ingestion, dedupe and rights), so only the link is per user.
 *
 *   discovery_run ─< discovery_query >─ discovery_search (shared cache)
 *        user ─< user_discovery >─ content_item, via the query that found it
 *
 * Everything a model produced records how (`method`, `model`, `prompt_version`),
 * like letters, summaries and imports.
 */

export const discoveryRunStatus = pgEnum("discovery_run_status", ["pending", "running", "done", "failed"]);
/**
 * What happened to a generated query: `searched` (a new web search),
 * `cached` (served from `discovery_search`), `skipped_stale` (it found nothing
 * recently), `skipped_recent` (this user ran it recently), `skipped_cap`
 * (over the per-letter search cap), `duplicate` (same as another query in the
 * run), `failed` (the search errored).
 */
export const discoveryQueryStatus = pgEnum("discovery_query_status", [
  "pending",
  "searched",
  "cached",
  "skipped_stale",
  "skipped_recent",
  "skipped_cap",
  "duplicate",
  "failed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

/** One page a search returned, with the model's one-line reason. Never used as letter copy. */
export interface DiscoveryResult {
  url: string;
  title: string | null;
  /** Why it fits the query, in one line, from the search results (not the page). */
  reason: string;
}

/**
 * One discovery pass for one letter occurrence, a few hours before it's
 * assembled. `(user_id, occurrence_id)` is unique, so overlapping sweeps start
 * at most one run per letter (like `letter`).
 */
export const discoveryRun = pgTable(
  "discovery_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The letter occurrence it feeds: `<local date>#<schedule version>`, as on `letter`. */
    occurrenceId: text("occurrence_id").notNull(),
    status: discoveryRunStatus("status").default("pending").notNull(),
    /** When the letter it feeds is due. */
    letterDueAt: timestamp("letter_due_at", { withTimezone: true }).notNull(),
    /** sha256 of the query generator's input (the user's brief), so a run can be reproduced. */
    inputsHash: text("inputs_hash"),
    /** How the queries were written: "anthropic", "claude-cli" or "fallback" (from the user's topics, no model). */
    queryMethod: text("query_method"),
    queryModel: text("query_model"),
    queryPromptVersion: text("query_prompt_version"),
    /** Queries generated, new web searches run (billed), and searches served from the shared cache. */
    queriesGenerated: integer("queries_generated").default(0).notNull(),
    searchesRun: integer("searches_run").default(0).notNull(),
    cacheHits: integer("cache_hits").default(0).notNull(),
    /** Pages newly linked to the user by this run. */
    itemsLinked: integer("items_linked").default(0).notNull(),
    /** Of those, pages new to the catalog (queued for extraction). */
    itemsQueued: integer("items_queued").default(0).notNull(),
    /** When a worker claimed it. A `running` run older than the lease (a crashed worker) can be claimed again. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps,
  },
  (t) => [unique("discovery_run_user_occurrence").on(t.userId, t.occurrenceId), index("discovery_run_status_idx").on(t.status)],
);

/**
 * Shared search-result cache across users (§6.3a, budget): one row per
 * normalized query (see @fs/core `normalizeQuery`), reused until
 * `expires_at`. Results are what the search returned under the global block
 * list and the first searcher's own blocks; each user's blocks are applied
 * again when the cache is read.
 */
export const discoverySearch = pgTable(
  "discovery_search",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedQuery: text("normalized_query").notNull().unique(),
    /** The query as it was searched. */
    queryText: text("query_text").notNull(),
    results: jsonb("results").$type<DiscoveryResult[]>().default([]).notNull(),
    resultCount: integer("result_count").default(0).notNull(),
    /** Web searches the model actually made for it (what's billed). */
    webSearches: integer("web_searches").default(0).notNull(),
    /** "anthropic" or "claude-cli". */
    method: text("method").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    searchedAt: timestamp("searched_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("discovery_search_expires_idx").on(t.expiresAt)],
);

/**
 * Every query a run generated, with what it came from and what it found,
 * including the ones skipped. Lets us see which queries find good material
 * and skip ones that recently found nothing.
 */
export const discoveryQuery = pgTable(
  "discovery_query",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => discoveryRun.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Its place in the generator's list (0 = best), which is the order queries are searched in. */
    position: integer("position").notNull(),
    queryText: text("query_text").notNull(),
    /** The cache key (@fs/core `normalizeQuery`). */
    normalizedQuery: text("normalized_query").notNull(),
    /** What it was generated from: `role`, `lately`, `topic`, `fact`, `review`, `leaning`. */
    origin: text("origin").notNull(),
    /** The user's words or the topic it came from, when there is one. */
    originDetail: text("origin_detail"),
    /** Same as the run's: how this query was written and from which input. */
    inputsHash: text("inputs_hash").notNull(),
    method: text("method").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    status: discoveryQueryStatus("status").default("pending").notNull(),
    /** The search its results came from (new or cached). */
    searchId: uuid("search_id").references(() => discoverySearch.id, { onDelete: "set null" }),
    /** Results after this user's blocks, and how many were newly linked to the user. */
    resultCount: integer("result_count"),
    acceptedCount: integer("accepted_count"),
    ranAt: timestamp("ran_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("discovery_query_user_query_idx").on(t.userId, t.normalizedQuery, t.ranAt), index("discovery_query_run_idx").on(t.runId)],
);

/**
 * A page discovery found for a user: the per-user link that makes a shared
 * `content_item` one of their letter candidates (collect unions these with
 * followed sources). One per user and item; the first finding wins.
 */
export const userDiscovery = pgTable(
  "user_discovery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    queryId: uuid("query_id").references(() => discoveryQuery.id, { onDelete: "set null" }),
    /** The search's one-line reason; becomes the `discovered` pick signal's detail. */
    reason: text("reason").notNull(),
    foundAt: timestamp("found_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("user_discovery_user_item").on(t.userId, t.itemId), index("user_discovery_item_idx").on(t.itemId)],
);

/**
 * A user's own standing with a publisher (§6.3a): blocked by them, or by the
 * rules from their votes (@fs/core `userPublisherVerdict`). Blocked publishers
 * are passed to search as `blocked_domains` and kept out of their letters.
 * Following one is a `user_source` on its feed.
 */
export const userPublisher = pgTable(
  "user_publisher",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => publisher.id, { onDelete: "cascade" }),
    blocked: boolean("blocked").default(false).notNull(),
    /** `user` (they blocked it) or `votes` (their negative votes did). A user's choice is never undone by the rules. */
    blockedReason: text("blocked_reason"),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("user_publisher_user_publisher").on(t.userId, t.publisherId)],
);
