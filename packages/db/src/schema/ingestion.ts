import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/** Dimensions of the item embedding (Titan Text Embeddings v2 and Cohere Embed v4 both support 1024). */
export const EMBEDDING_DIMENSIONS = 1024;

export const publisherStatus = pgEnum("publisher_status", ["candidate", "trial", "trusted", "blocked"]);
export const publisherOrigin = pgEnum("publisher_origin", ["user_added", "discovered"]);
export const sourceType = pgEnum("source_type", ["feed", "url", "youtube_channel"]);
export const userSourceMode = pgEnum("user_source_mode", ["more_like_this", "follow_closely", "occasional"]);
export const rightsScope = pgEnum("rights_scope", ["domain", "source"]);
export const rightsDisplay = pgEnum("rights_display", ["full_text", "excerpt_only", "link_only"]);
export const contentType = pgEnum("content_type", ["article", "video"]);
export const contentStatus = pgEnum("content_status", ["pending", "extracted", "metadata_only", "enriched", "failed"]);
export const enrichmentBatchStatus = pgEnum("enrichment_batch_status", ["submitted", "applied", "failed"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

/**
 * The growing publisher catalog (build plan §6.3a). Shared across users.
 * `key` is the host without `www.` for the web, or `youtube:<channelId>`.
 */
export const publisher = pgTable("publisher", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  feedUrl: text("feed_url"),
  status: publisherStatus("status").default("candidate").notNull(),
  origin: publisherOrigin("origin").notNull(),
  // Quality stats. Counts rather than rates, so updates are simple increments.
  itemsSeen: integer("items_seen").default(0).notNull(),
  extractionsOk: integer("extractions_ok").default(0).notNull(),
  extractionsFailed: integer("extractions_failed").default(0).notNull(),
  verificationsPassed: integer("verifications_passed").default(0).notNull(),
  verificationsFailed: integer("verifications_failed").default(0).notNull(),
  interestedCount: integer("interested_count").default(0).notNull(),
  notInterestedCount: integer("not_interested_count").default(0).notNull(),
  /** Politeness: the last time any of our workers fetched from this host. */
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
});

/** Overrides the personal-use default (full text, retained, offline). Source rules beat domain rules. */
export const rightsRule = pgTable(
  "rights_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: rightsScope("scope").notNull(),
    /** A publisher key for `domain`, a source canonical key for `source`. */
    scopeKey: text("scope_key").notNull(),
    display: rightsDisplay("display").notNull(),
    retainText: boolean("retain_text").notNull(),
    offlineAllowed: boolean("offline_allowed").notNull(),
    licenseNote: text("license_note"),
    ...timestamps,
  },
  (t) => [unique("rights_rule_scope_key").on(t.scope, t.scopeKey)],
);

/** Something we poll or ingest once. Shared across users. */
export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Feed URL, `youtube:<channelId>`, or the canonical URL of a single page. */
    canonicalKey: text("canonical_key").notNull().unique(),
    type: sourceType("type").notNull(),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => publisher.id),
    title: text("title").notNull(),
    creator: text("creator"),
    /** What the user pasted. */
    inputUrl: text("input_url").notNull(),
    /** Where entries are listed from: the feed URL, the page URL, or the uploads playlist ID. */
    fetchUrl: text("fetch_url").notNull(),
    /** Null for one-off URL sources once ingested. */
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastFetchStatus: text("last_fetch_status"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    etag: text("etag"),
    lastModified: text("last_modified"),
    ...timestamps,
  },
  (t) => [index("source_next_fetch_at_idx").on(t.nextFetchAt)],
);

export const userSource = pgTable(
  "user_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    mode: userSourceMode("mode").default("more_like_this").notNull(),
    blocked: boolean("blocked").default(false).notNull(),
    ...timestamps,
  },
  (t) => [unique("user_source_user_source").on(t.userId, t.sourceId)],
);

/** Message Batches submitted for enrichment (build plan §6.3). Polled by the sweep. */
export const enrichmentBatch = pgTable("enrichment_batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerBatchId: text("provider_batch_id").notNull().unique(),
  status: enrichmentBatchStatus("status").default("submitted").notNull(),
  itemCount: integer("item_count").notNull(),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** A piece of content with a stable ID reused across letters. */
export const contentItem = pgTable(
  "content_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalUrl: text("canonical_url").notNull().unique(),
    type: contentType("type").notNull(),
    sourceId: uuid("source_id").references(() => source.id),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => publisher.id),
    title: text("title"),
    creator: text("creator"),
    /** The byline from the page or feed entry, or the channel for a video. */
    authorName: text("author_name"),
    /** `author.key` for `author_name` (see @fs/core `authorKeyFor`). */
    authorKey: text("author_key"),
    /** og:image / twitter:image / the first article image; the thumbnail for a video. */
    leadImageUrl: text("lead_image_url"),
    /** Videos only. */
    durationSeconds: integer("duration_seconds"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** YouTube video ID for videos. */
    externalId: text("external_id"),
    status: contentStatus("status").default("pending").notNull(),
    /** Why an item is metadata-only or failed: `paywalled`, `access_denied`, `transcript_missing`, … */
    statusReason: text("status_reason"),
    wordCount: integer("word_count"),
    readTimeMinutes: integer("read_time_minutes"),
    /** 64-bit SimHash of the extracted text, for near-duplicate detection. */
    simhash: bigint("simhash", { mode: "bigint" }),
    duplicateOfId: uuid("duplicate_of_id"),
    // Enrichment
    language: text("language"),
    tags: text("tags").array(),
    depth: text("depth"),
    qualityLabel: text("quality_label"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    enrichmentBatchId: uuid("enrichment_batch_id").references(() => enrichmentBatch.id),
    enrichmentAttempts: integer("enrichment_attempts").default(0).notNull(),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("content_item_status_idx").on(t.status),
    index("content_item_publisher_idx").on(t.publisherId),
    index("content_item_source_idx").on(t.sourceId),
    index("content_item_author_key_idx").on(t.authorKey),
    check("content_item_video_has_id", sql`${t.type} <> 'video' OR ${t.externalId} IS NOT NULL`),
  ],
);

/** One fetched version of an item. A new row is created when the content hash changes. */
export const contentVersion = pgTable(
  "content_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
    /** Null unless the rights rule allows retaining text. */
    blocksKey: text("blocks_key"),
    sectionMap: jsonb("section_map").notNull(),
    rightsSnapshot: jsonb("rights_snapshot").notNull(),
    /** A short plain-text excerpt, kept even when blocks aren't retained (digest/fallback page). */
    excerpt: text("excerpt"),
  },
  (t) => [unique("content_version_item_hash").on(t.itemId, t.contentHash)],
);

/** No row → the video can be saved but gets no skim. */
export const transcript = pgTable("transcript", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemVersionId: uuid("item_version_id")
    .notNull()
    .unique()
    .references(() => contentVersion.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** `native` captions or `generated` (AI transcription). */
  provenance: text("provenance").notNull(),
  confidence: real("confidence"),
  language: text("language"),
  key: text("key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sourceRelations = relations(source, ({ one }) => ({
  publisher: one(publisher, { fields: [source.publisherId], references: [publisher.id] }),
}));

export const userSourceRelations = relations(userSource, ({ one }) => ({
  user: one(user, { fields: [userSource.userId], references: [user.id] }),
  source: one(source, { fields: [userSource.sourceId], references: [source.id] }),
}));

export const contentItemRelations = relations(contentItem, ({ one, many }) => ({
  source: one(source, { fields: [contentItem.sourceId], references: [source.id] }),
  publisher: one(publisher, { fields: [contentItem.publisherId], references: [publisher.id] }),
  versions: many(contentVersion),
}));

export const contentVersionRelations = relations(contentVersion, ({ one }) => ({
  item: one(contentItem, { fields: [contentVersion.itemId], references: [contentItem.id] }),
}));
