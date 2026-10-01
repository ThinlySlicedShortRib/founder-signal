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
