import { z } from "zod";

/**
 * Contracts shared by the API, workers and the Expo app.
 * Keep this package free of Node-only imports: the mobile app bundles it.
 */

/** Error codes returned as `{ code, message }` (build plan §7). */
export const errorCodes = [
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "SOURCE_UNAVAILABLE",
  "FULL_TEXT_UNLICENSED",
  "TRANSCRIPT_MISSING",
  "GENERATION_FAILED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const apiErrorSchema = z.object({
  code: z.enum(errorCodes),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** One error report from the mobile app, sent to POST /client-logs. */
export const clientLogEntrySchema = z.object({
  level: z.enum(["error", "warn", "info"]),
  message: z.string().max(2_000),
  stack: z.string().max(16_000).optional(),
  /** Where it happened, e.g. the route path or a component name. */
  context: z.string().max(200).optional(),
  fatal: z.boolean().default(false),
  occurredAt: z.iso.datetime(),
  app: z.object({
    version: z.string().max(50),
    updateId: z.string().max(100).nullish(),
    platform: z.enum(["ios", "android", "web"]),
    osVersion: z.string().max(50).optional(),
  }),
});
export type ClientLogEntry = z.infer<typeof clientLogEntrySchema>;

export const clientLogBatchSchema = z.object({
  entries: z.array(clientLogEntrySchema).min(1).max(50),
});
export type ClientLogBatch = z.infer<typeof clientLogBatchSchema>;

// ── Content (build plan §6.3) ───────────────────────────────────────────────

/** Extracted article content, rendered natively by the Reader's BlockRenderer. */
export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), text: z.string() }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("quote"), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("image"), src: z.url(), alt: z.string().optional(), caption: z.string().optional() }),
  z.object({ type: z.literal("caption"), text: z.string() }),
  z.object({ type: z.literal("table"), header: z.array(z.string()).optional(), rows: z.array(z.array(z.string())) }),
]);
export type Block = z.infer<typeof blockSchema>;

/** A contiguous run of blocks, `[startBlock, endBlock)`. Section summaries are keyed by `id`. */
export const sectionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startBlock: z.number().int().min(0),
  endBlock: z.number().int().min(0),
});
export type Section = z.infer<typeof sectionSchema>;

export const rightsDisplays = ["full_text", "excerpt_only", "link_only"] as const;
export type RightsDisplay = (typeof rightsDisplays)[number];

export const rightsSchema = z.object({
  display: z.enum(rightsDisplays),
  retainText: z.boolean(),
  offlineAllowed: z.boolean(),
  licenseNote: z.string().nullable().optional(),
});
export type Rights = z.infer<typeof rightsSchema>;

/** Why an item has no usable body. Nothing is ever generated from a title alone. */
export const unavailableReasons = [
  "paywalled",
  "access_denied",
  "not_found",
  "not_html",
  "too_short",
  "fetch_failed",
  "blocked_address",
  "transcript_missing",
] as const;
export type UnavailableReason = (typeof unavailableReasons)[number];

// ── Sources (build plan §7: /me/sources) ────────────────────────────────────

export const sourceModes = ["more_like_this", "follow_closely", "occasional"] as const;
export type SourceMode = (typeof sourceModes)[number];

export const sourceTypes = ["feed", "url", "youtube_channel"] as const;
export type SourceType = (typeof sourceTypes)[number];

export const addSourceInputSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  mode: z.enum(sourceModes).default("more_like_this"),
});
export type AddSourceInput = z.infer<typeof addSourceInputSchema>;

export const updateSourceInputSchema = z
  .object({ mode: z.enum(sourceModes), blocked: z.boolean() })
  .partial()
  .refine((v) => v.mode !== undefined || v.blocked !== undefined, "Nothing to update");
export type UpdateSourceInput = z.infer<typeof updateSourceInputSchema>;

export const sourceViewSchema = z.object({
  id: z.uuid(),
  type: z.enum(sourceTypes),
  title: z.string(),
  creator: z.string().nullable(),
  url: z.string(),
  mode: z.enum(sourceModes),
  blocked: z.boolean(),
  publisher: z.object({ id: z.uuid(), name: z.string(), status: z.string() }),
  rights: rightsSchema,
  lastFetchStatus: z.string().nullable(),
  lastFetchedAt: z.iso.datetime().nullable(),
  itemCount: z.number().int(),
});
export type SourceView = z.infer<typeof sourceViewSchema>;

// ── Profile and onboarding (build plan §7: /me/preferences, /me/schedule) ───

/**
 * Suggested answers for the fill-in sentence. Every field also takes the
 * user's own words, so these are starting points, not the allowed values.
 */
export const roles = ["founder", "startup operator", "consultant", "founder-to-be", "investor"] as const;
export type Role = (typeof roles)[number];

/** "Send me more on ___." Suggested topics; users add their own as tags. */
export const topics = [
  "business models",
  "pricing",
  "open source",
  "developer tools",
  "first customers",
  "sales",
  "hiring",
  "fundraising",
  "AI tools",
  "distribution",
] as const;
export type Topic = (typeof topics)[number];

/** "I follow people on ___." The places that can be connected; users can name others. */
export const readingPlatforms = ["youtube", "x", "substack"] as const;
export type ReadingPlatform = (typeof readingPlatforms)[number];

/** The assistants a profile can be imported from. */
export const assistants = ["chatgpt", "claude", "gemini"] as const;
export type Assistant = (typeof assistants)[number];

/** A free-text answer: a role, a topic tag, a place someone reads. */
const shortText = (max: number) => z.string().trim().min(1).max(max);

/** Lines of an imported profile, by the heading the import prompt asks for. */
export const profileFactKinds = ["work", "building", "curious", "recurring", "source"] as const;
export type ProfileFactKind = (typeof profileFactKinds)[number];

/** A newsletter, site, channel or person the note says the user reads. */
export const namedSourceSchema = z.object({
  name: shortText(120),
  /** Only when the note gives one; never guessed. */
  url: z.string().trim().max(2_000).nullable().default(null),
});
export type NamedSource = z.infer<typeof namedSourceSchema>;

/** The parts of the onboarding form one fact fills. Unticking the fact removes them. */
export const factFillsSchema = z.object({
  role: shortText(80).nullable().default(null),
  lately: shortText(300).nullable().default(null),
  topics: z.array(shortText(60)).max(8).default([]),
  platforms: z.array(z.enum(readingPlatforms)).max(readingPlatforms.length).default([]),
  sources: z.array(namedSourceSchema).max(10).default([]),
});
export type FactFills = z.infer<typeof factFillsSchema>;

export const profileFactSchema = z.object({
  kind: z.enum(profileFactKinds),
  text: z.string().trim().min(1).max(300),
  fills: factFillsSchema.default({ role: null, lately: null, topics: [], platforms: [], sources: [] }),
});
export type ProfileFact = z.infer<typeof profileFactSchema>;

/** What an import left out of the form because it looked personal. Only the category is shown. */
export const sensitiveCategories = ["health", "finances", "family", "other_people", "confidential", "credentials"] as const;
export type SensitiveCategory = (typeof sensitiveCategories)[number];

export const importProfileInputSchema = z.object({
  assistant: z.enum(assistants),
  /** The assistant's answer, pasted. Saved with the import so the user can come back to it. */
  text: z.string().trim().min(1).max(20_000),
});
export type ImportProfileInput = z.infer<typeof importProfileInputSchema>;

/** The structured reading of an import: facts to review, each carrying the answers it fills. */
export const importProfileResultSchema = z.object({
  importId: z.uuid(),
  facts: z.array(profileFactSchema),
  dropped: z.array(z.object({ category: z.enum(sensitiveCategories) })),
});
export type ImportProfileResult = z.infer<typeof importProfileResultSchema>;

/** The last import, so the paste is there when the user comes back. */
export const savedImportSchema = z.object({
  id: z.uuid(),
  assistant: z.enum(assistants),
  text: z.string(),
  result: importProfileResultSchema,
  createdAt: z.iso.datetime(),
});
export type SavedImport = z.infer<typeof savedImportSchema>;

export const updateProfileInputSchema = z
  .object({
    role: shortText(80).nullable(),
    /** "Lately I've been into ___": free text, or null when skipped. */
    lately: z.string().trim().max(500).nullable(),
    /** Suggested topics and the user's own tags. */
    topics: z.array(shortText(60)).max(30),
    /** Connectable platforms by ID, or anywhere else in the user's words. */
    platforms: z.array(shortText(40)).max(10),
    /** The facts the user kept from an import, replacing any earlier ones. */
    imported: z
      .object({ importId: z.uuid().nullable().default(null), assistant: z.enum(assistants), facts: z.array(profileFactSchema).max(30) })
      .nullable(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/** "Send it ___." Each preset is a set of weekdays and a local time. */
export const deliveryPresets = ["weekday_mornings", "lunch", "sunday_mornings", "evenings"] as const;
export type DeliveryPreset = (typeof deliveryPresets)[number];

export const updateScheduleInputSchema = z.object({
  preset: z.enum(deliveryPresets),
  /** IANA time zone of the device, e.g. "Europe/London". */
  timeZone: z.string().min(1).max(64),
});
export type UpdateScheduleInput = z.infer<typeof updateScheduleInputSchema>;

export const scheduleViewSchema = z.object({
  preset: z.enum(deliveryPresets).nullable(),
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: z.array(z.number().int().min(0).max(6)),
  /** "HH:MM", in `timeZone`. */
  localTime: z.string(),
  timeZone: z.string(),
  paused: z.boolean(),
  nextRunAt: z.iso.datetime().nullable(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

export const profileViewSchema = z.object({
  role: z.string().nullable(),
  lately: z.string().nullable(),
  topics: z.array(z.string()),
  platforms: z.array(z.string()),
  imported: z.object({ importId: z.uuid().nullable(), assistant: z.enum(assistants), facts: z.array(profileFactSchema) }).nullable(),
  schedule: scheduleViewSchema.nullable(),
  onboardedAt: z.iso.datetime().nullable(),
});
export type ProfileView = z.infer<typeof profileViewSchema>;

// ── Reviews (build plan §7: PUT /items/:id/review) ──────────────────────────

export const reviewVotes = ["interested", "not_interested"] as const;
export type ReviewVote = (typeof reviewVotes)[number];

/** "What did you like about it?" */
export const likeReasons = ["topic", "creator", "practical", "numbers", "depth", "concise", "fresh_take", "video"] as const;
export type LikeReason = (typeof likeReasons)[number];

export const reviewOrigins = ["in_app", "onboarding", "imported"] as const;
export type ReviewOrigin = (typeof reviewOrigins)[number];

export const putReviewInputSchema = z.object({
  vote: z.enum(reviewVotes),
  reasons: z.array(z.enum(likeReasons)).max(likeReasons.length).default([]),
  freeText: z.string().trim().max(1_000).nullable().default(null),
  origin: z.enum(reviewOrigins).default("in_app"),
});
export type PutReviewInput = z.infer<typeof putReviewInputSchema>;

/** One card in onboarding's five quick picks. */
export const calibrationPickSchema = z.object({
  id: z.uuid(),
  type: z.enum(["article", "video"]),
  title: z.string(),
  publisher: z.string(),
  creator: z.string().nullable(),
  readTimeMinutes: z.number().int().nullable(),
  /** A line from the piece itself, for the pull quote. */
  quote: z.string().nullable(),
  /** The user topic it matched, if any. */
  matchedTopic: z.string().nullable(),
  /** From a source the user added; otherwise, with no topic match, it's a wildcard. */
  fromFollowedSource: z.boolean(),
  tags: z.array(z.string()),
});
export type CalibrationPick = z.infer<typeof calibrationPickSchema>;
