import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/** Where an import's list came from (docs/imports/README.md). */
export const sourceImportMethod = pgEnum("source_import_method", ["opml", "youtube", "substack", "bluesky", "mastodon", "newsletter"]);

/**
 * One "import what I already follow" run: what was found (the checklist) and
 * how much of it was added. Sources added from it point back here through
 * `user_source.import_id`, so where each source came from is kept.
 */
export const sourceImport = pgTable(
  "source_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    method: sourceImportMethod("method").notNull(),
    /** The handle, the OPML file's name, or the YouTube account. */
    label: text("label").notNull(),
    /** What was found, as offered on the checklist (`FoundSource & { key }` from @fs/ingest). */
    candidates: jsonb("candidates").notNull(),
    /** Why some entries aren't on the checklist (over the cap, no feed, hidden follows). */
    notes: text("notes").array().default([]).notNull(),
    foundCount: integer("found_count").notNull(),
    /** Sources linked from this import so far (confirm can run more than once). */
    addedCount: integer("added_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [index("source_import_user_idx").on(t.userId, t.createdAt)],
);

/**
 * A pending OAuth connection (Connect YouTube). The browser carries only the
 * random `state`; its SHA-256 is the key here, with the user who started it,
 * the PKCE verifier and where to send the browser back. Single use: the
 * callback deletes the row it consumes. Expires after a few minutes.
 */
export const oauthFlow = pgTable("oauth_flow", {
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
