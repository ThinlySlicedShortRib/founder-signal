import type { ApiError, ErrorCode } from "@fs/schema";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function apiError(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json<ApiError>({ code, message }, status);
}
