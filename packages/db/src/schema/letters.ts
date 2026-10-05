import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { contentItem, contentVersion, source } from "./ingestion.ts";

/**
 * The letter engine (build plan §5, §6.1–6.7): letters and their pieces,
 * reading events, the shared section-summary cache, authors and stock photos.
 */

/**
 * The pipeline's state machine (§6.2), plus `skipped` for an occurrence the
 * user skipped with "skip next" (recorded so history is honest, never shown).
 */
export const letterStatus = pgEnum("letter_status", [
  "scheduled",
  "collecting",
  "ranking",
  "generating",
  "verifying",
  "ready",
  "sending",
  "sent",
  "short_sent",
  "skipped_no_candidates",
  "failed",
  "skipped",
]);
export const interactionType = pgEnum("interaction_type", ["open", "complete", "uncomplete", "save", "unsave", "summary_expand", "skip"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

/** How a letter's copy was written, so any letter can be reproduced (§6.5). */
export interface GenerationMeta {
  /** "anthropic", "claude-cli" or "fallback" (copy from excerpts when no model is available). */
  method: string;
  model: string | null;
  promptVersion: string;
  /** sha256 of the writer's input (brief, passages, picks). */
  inputHash: string;
  /** Writer calls made: 1, or 2 when a regeneration was needed. */
  calls: number;
  /** Pieces that failed verification and why, for the substitution-rate alarm (§9). */
  rejected: { itemId: string; reasons: string[] }[];
  /** Why the writer fell back, when it did. */
  fallbackReason?: string;
}

/** How the feedback P.S. recap was written. */
export interface RecapMeta {
  /** "anthropic", "claude-cli" or "fallback" (from the user's reasons, when no model is available or its text failed the checks). */
  method: string;
  model: string | null;
  promptVersion: string;
  fallbackReason?: string;
}

/**
 * The pipeline's working state between steps (§6.2: each step writes its
 * output before advancing, so re-running a step after a crash is safe).
 */
export interface LetterWork {
  candidates?: string[];
  /** Ranked picks then the reserve, best first, with their top signals. */
  ranked?: RankedEntry[];
  /** How many of `ranked` are picks; the rest is the reserve. */
  pickCount?: number;
  /** Copy per item from the generate step, keyed by item ID. */
  drafts?: Record<string, DraftCopy>;
  /** The writer's letter-level copy. `postscript` is missing on letters generated before it was written. */
  letterCopy?: { headline: string; intro: string; postscript?: string };
  generation?: GenerationMeta;
  /** What the writer was given (brief and pieces with passages), kept for verification and reproduction. */
  writer?: { brief: Record<string, unknown>; pieces: Record<string, unknown>[] };
}

/**
 * How a letter's candidates were collected (§6.2, "Every letter has at least
 * three pieces"): the escalation steps that ran, in order, with the
 * candidate count after each. A letter held for discovery and collected
 * again lists both passes. Shown in Dev tools.
 */
export interface LetterCollection {
  /** Pieces the letter was planned with (`piecesWanted`). */
  wanted: number;
  steps: { step: "own" | "widened" | "shared_pool" | "discovery"; total: number; added: number }[];
  /** Candidates at the end. */
  candidates: number;
  /** Of those, items from the shared pool (ranked with a penalty). */
  shared: string[];
  /** It was held for a discovery run of its own (at most once). */
  heldForDiscovery: boolean;
  /** Whether discovery could still run when collection stopped: "available" (not needed), "ran" or "off". */
  discovery: "available" | "ran" | "off";
  /** Extra reserve pieces verification loaded (with copy from their own words) to stay at `wanted`. */
  extraSubstitutes?: number;
}

export interface RankedEntry {
  itemId: string;
  score: number;
  topic: string;
  signals: PickSignal[];
}

/** One contributing signal; the app turns these into "why this was picked", never showing scores. */
export interface PickSignal {
  kind: string;
  weight: number;
  /** The user's own words or the matched topic, when there is one. */
  detail: string | null;
}

export interface DraftCopy {
  whyPicked: string | null;
  summary: string;
  tag: string | null;
  evidenceIds: string[];
}

/** The copy a piece was delivered with (§5: the snapshot preserves historical copy). */
export interface LetterItemSnapshot {
  kind: "article" | "video";
  title: string;
  topic: string;
  minutes: number;
  whyPicked: string | null;
  summary: string;
  tag: string | null;
  sourceName: string;
  /** Null for a newsletter that arrived by email with no web version. */
  originalUrl: string | null;
  image: { url: string; source: "article" | "stock"; credit: string | null; creditUrl: string | null } | null;
  /**
   * The contents-list icon, a `pieceIconKeys` key (@fs/schema): enrichment's
   * pick, else the fallback from tags, topic and title. Absent on letters
   * locked before icons; those are resolved on read.
   */
  icon?: string;
  /** Who wrote it, as known at delivery. The card's details are read live from `author`. */
  author: { key: string; name: string } | null;
  evidenceIds: string[];
  /** The profile version the copy was written against. */
  profileVersion: number | null;
}

/** One letter per user and occurrence (§6.1). `(user_id, occurrence_id)` is the duplicate-delivery guard. */
export const letter = pgTable(
  "letter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `<local date>#<schedule version>`, `first` for the one made when onboarding ends, or `test#<uuid>` for a test letter. */
    occurrenceId: text("occurrence_id").notNull(),
    status: letterStatus("status").default("scheduled").notNull(),
    isTest: boolean("is_test").default(false).notNull(),
    /** When it's due to be delivered (UTC), and the user's local date for it. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    /** "Letter No. n": assigned when delivered, counting this user's delivered letters. */
    number: integer("number"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Fewer pieces than asked for, after verification (§6.2); delivered as `short_sent`. */
    short: boolean("short").default(false).notNull(),
    headline: text("headline"),
    intro: text("intro"),
    whyThisMix: text("why_this_mix"),
    generationMeta: jsonb("generation_meta").$type<GenerationMeta>(),
    /** Attempts per step, e.g. `{ "collecting": 1, "generating": 2 }`. */
    stepAttempts: jsonb("step_attempts").$type<Record<string, number>>().default({}).notNull(),
    work: jsonb("work").$type<LetterWork>().default({}).notNull(),
    /** When the watchdog should next look at this letter if it hasn't moved (§6.1). */
    watchdogAt: timestamp("watchdog_at", { withTimezone: true }),
    /**
     * Held in `scheduled` until the discovery run with the same occurrence ID
     * has finished and its pages are extracted (§6.3a: the first letter, and a
     * test letter with little to pick from). `watchdog_at` is then the latest
     * it may start.
     */
    awaitingDiscovery: boolean("awaiting_discovery").default(false).notNull(),
    failureReason: text("failure_reason"),
    /** How its candidates were collected: the escalation steps that ran (`LetterCollection`). */
    collection: jsonb("collection").$type<LetterCollection>(),
    /** Why it has fewer pieces than planned (or none), when it does: what was tried, and what ran out. */
    shortReason: text("short_reason"),
    /** "Tomorrow, more of": the options offered, and what the user picked (read by the next letter's rank step). */
    leanings: text("leanings").array().default([]).notNull(),
    chosenLeanings: text("chosen_leanings").array().default([]).notNull(),
    /**
     * The P.S. before any feedback: a quick recap of the pieces, written with the letter at lock
     * (the writer's, or from the titles when its copy can't be used; `generation_meta` says which writer).
     */
    postscriptDefault: text("postscript_default"),
    /**
     * The P.S. once the user has given feedback on the pieces, the signature of the verdicts and
     * reasons it was written from, and how it was written. Rewritten when they change; cleared
     * when the feedback is removed, so the default shows again.
     */
    postscriptRecap: text("postscript_recap"),
    postscriptRecapSignature: text("postscript_recap_signature"),
    postscriptRecapMeta: jsonb("postscript_recap_meta").$type<RecapMeta>(),
    ...timestamps,
  },
  (t) => [
    unique("letter_user_occurrence").on(t.userId, t.occurrenceId),
    unique("letter_user_number").on(t.userId, t.number),
    index("letter_status_watchdog_idx").on(t.status, t.watchdogAt),
    index("letter_user_delivered_idx").on(t.userId, t.deliveredAt),
    index("letter_awaiting_discovery_idx").on(t.userId).where(sql`${t.awaitingDiscovery}`),
  ],
);

/** A piece in a letter (§5). Feedback codes are unique within the letter (§6.7). */
export const letterItem = pgTable(
  "letter_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    letterId: uuid("letter_id")
      .notNull()
      .references(() => letter.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    feedbackCode: text("feedback_code").notNull(),
    snapshot: jsonb("snapshot").$type<LetterItemSnapshot>().notNull(),
    pickSignals: jsonb("pick_signals").$type<PickSignal[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("letter_item_letter_item").on(t.letterId, t.itemId),
    unique("letter_item_letter_code").on(t.letterId, t.feedbackCode),
    unique("letter_item_letter_position").on(t.letterId, t.position),
    index("letter_item_item_idx").on(t.itemId),
  ],
);

/** Reading events (§6.6). `event_id` is the client's UUID, so a resent outbox is ignored. */
export const interaction = pgTable(
  "interaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    letterId: uuid("letter_id").references(() => letter.id, { onDelete: "set null" }),
    type: interactionType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Set on the device when it happened; never recomputed (§6.6). */
    localDay: date("local_day", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("interaction_user_day_idx").on(t.userId, t.localDay), index("interaction_user_item_idx").on(t.userId, t.itemId)],
);

/** "Summarize this section" (§6.5): a shared cache of claim and evidence. "For you" is per user and never stored. */
export const summary = pgTable(
  "summary",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemVersionId: uuid("item_version_id")
      .notNull()
      .references(() => contentVersion.id, { onDelete: "cascade" }),
    sectionId: text("section_id").notNull(),
    claim: text("claim").notNull(),
    evidence: text("evidence").notNull(),
    /** "anthropic", "claude-cli" or "fallback". */
    method: text("method").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("summary_version_section").on(t.itemVersionId, t.sectionId)],
);

/** A number about an author, with the source that says it. Only sourced stats are kept. */
export interface AuthorStat {
  value: string;
  label: string;
  source: { name: string; url: string };
}

/**
 * Who wrote a piece. Shared across users and enriched once (re-checked after
 * ~90 days) with Claude and web search. `key` is `youtube:<channelId>` for a
 * channel, or `<publisher key>:<name slug>` for a byline.
 */
export const author = pgTable("author", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  role: text("role"),
  headline: text("headline"),
  short: text("short"),
  bio: text("bio"),
  stats: jsonb("stats").$type<AuthorStat[]>().default([]).notNull(),
  knownFor: text("known_for").array().default([]).notNull(),
  siteUrl: text("site_url"),
  /** What following them adds as a source: their channel, or their own site's feed. */
  followUrl: text("follow_url"),
  provenance: text("provenance"),
  /** Pages the details came from. */
  sources: jsonb("sources").$type<{ name: string; url: string }[]>().default([]).notNull(),
  /** `pending`, `enriched`, `not_found` (nothing reliable; the card is just the name) or `failed`. */
  enrichmentStatus: text("enrichment_status").default("pending").notNull(),
  enrichmentMethod: text("enrichment_method"),
  /** Lease: another worker doesn't start enriching while this is recent. */
  enrichmentStartedAt: timestamp("enrichment_started_at", { withTimezone: true }),
  enrichmentAttempts: integer("enrichment_attempts").default(0).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  ...timestamps,
});

export const userAuthor = pgTable(
  "user_author",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => author.id, { onDelete: "cascade" }),
    /** The source following added, if their feed or channel was known. */
    sourceId: uuid("source_id").references(() => source.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("user_author_user_author").on(t.userId, t.authorId)],
);

/** A stock photo for a topic, with the credit Unsplash requires. */
export interface StockPhoto {
  id: string;
  url: string;
  credit: string;
  creditUrl: string;
  /** Unsplash's download endpoint, called each time the photo is used (their API guidelines). */
  downloadLocation: string;
}

/** Stock photos per topic, cached so a topic costs one search (§ images). */
export const stockPhoto = pgTable("stock_photo", {
  topic: text("topic").primaryKey(),
  provider: text("provider").notNull(),
  photos: jsonb("photos").$type<StockPhoto[]>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});
