import { boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { contentItem } from "./ingestion.ts";

export const topicOrigin = pgEnum("topic_origin", ["explicit", "learned"]);
export const reviewVote = pgEnum("review_vote", ["interested", "not_interested"]);
export const reviewOrigin = pgEnum("review_origin", ["in_app", "onboarding", "imported"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export interface ImportedFact {
  kind: "work" | "building" | "curious" | "recurring" | "source";
  text: string;
  /** The parts of the onboarding form this fact fills. */
  fills: {
    role: string | null;
    lately: string | null;
    topics: string[];
    platforms: string[];
    sources: { name: string; url: string | null }[];
  };
}

/**
 * Each "import from your AI": the note the user pasted, kept so they can come
 * back to it, and the structured reading of it that filled their form.
 */
export const profileImport = pgTable(
  "profile_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assistant: text("assistant").notNull(),
    /** The pasted note, as pasted. TODO(M7): application-level encryption (§9); it can hold personal details. */
    rawText: text("raw_text").notNull(),
    /** `{ facts, dropped }` as shown to the user, after screening. */
    result: jsonb("result").$type<{ facts: ImportedFact[]; dropped: { category: string }[] }>().notNull(),
    /** "anthropic", "claude-cli" (local development) or "parser" (the fallback when neither is available or it failed). */
    method: text("method").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("profile_import_user_created_idx").on(t.userId, t.createdAt)],
);

/** One per user (build plan §5). `version` is bumped on every edit. */
export const profile = pgTable("profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role"),
  /** "Lately I've been into ___", in the user's words. TODO(M7): application-level encryption (§9). */
  lately: text("lately"),
  /** Where the user already reads (youtube, x, substack); connecting them comes later. */
  platforms: text("platforms").array().default([]).notNull(),
  /** The assistant an import came from. */
  importedFrom: text("imported_from"),
  /** The import whose facts the user kept. */
  importId: uuid("import_id").references(() => profileImport.id, { onDelete: "set null" }),
  /** The imported facts the user chose to keep. */
  importedFacts: jsonb("imported_facts").$type<ImportedFact[]>().default([]).notNull(),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  ...timestamps,
});

/** Explicit topics from onboarding and Preferences; learned weights come from reviews (M6). */
export const topicWeight = pgTable(
  "topic_weight",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    weight: real("weight").default(1).notNull(),
    origin: topicOrigin("origin").notNull(),
    ...timestamps,
  },
  (t) => [unique("topic_weight_user_topic").on(t.userId, t.topic)],
);

/** When letters arrive (build plan §5, §6.1). `next_run_at` is recomputed in the user's zone on every edit and run. */
export const schedule = pgTable(
  "schedule",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The onboarding choice this came from, if it's still unedited. */
    preset: text("preset"),
    /** 0 = Sunday … 6 = Saturday, in `time_zone`. */
    weekdays: integer("weekdays").array().notNull(),
    /** "HH:MM" */
    localTime: text("local_time").notNull(),
    timeZone: text("time_zone").notNull(),
    channels: text("channels").array().default(["push", "email"]).notNull(),
    paused: boolean("paused").default(false).notNull(),
    skipNext: boolean("skip_next").default(false).notNull(),
    /** When verification leaves fewer pieces than asked for: send a shorter letter, or skip it (§6.2). */
    shortLetterPolicy: text("short_letter_policy").default("shorten").notNull(),
    /** Pieces per letter (open item #2: 3 by default). */
    itemCount: integer("item_count").default(3).notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (t) => [index("schedule_next_run_at_idx").on(t.nextRunAt)],
);

/** A vote on an item, with reasons (build plan §5). One per user and item; edits overwrite. */
export const review = pgTable(
  "review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    vote: reviewVote("vote").notNull(),
    reasons: text("reasons").array().default([]).notNull(),
    /** TODO(M7): application-level encryption (§9). */
    freeText: text("free_text"),
    origin: reviewOrigin("origin").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [unique("review_user_item").on(t.userId, t.itemId)],
);
