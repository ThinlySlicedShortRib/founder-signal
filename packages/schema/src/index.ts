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
