import { createApiClient } from "@fs/api/client";
import { type ApiError as ApiErrorBody, apiErrorSchema, type ErrorCode } from "@fs/schema";
import { Platform } from "react-native";
import { authHeaders } from "./auth";
import { API_URL } from "./config";

/** An error response from our API, or a network failure (`OFFLINE`). */
export class ApiError extends Error {
  readonly code: ErrorCode | "OFFLINE";
  readonly status: number;

  constructor(code: ErrorCode | "OFFLINE", message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(await authHeaders())) headers.set(k, v);
  try {
    return await fetch(input, { ...init, headers, credentials: Platform.OS === "web" ? "include" : "omit" });
  } catch {
    throw new ApiError("OFFLINE", "Can't reach Founder Signal. Check your connection.", 0);
  }
}

/** Typed client generated from the API's routes (Hono `hc`). */
export const api = createApiClient(API_URL, { fetch: authedFetch });

/** The success body of a typed client response: every variant's body except the `{ code, message }` error. */
type SuccessBody<R> = R extends { json(): Promise<infer T> } ? Exclude<T, ApiErrorBody> : never;

/** Throws ApiError for non-2xx responses; otherwise returns the parsed JSON body. */
export async function unwrap<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(
  responsePromise: Promise<R>,
): Promise<SuccessBody<R>> {
  const res = await responsePromise;
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as SuccessBody<R>;
  const body = apiErrorSchema.safeParse(await res.json().catch(() => null));
  throw body.success
    ? new ApiError(body.data.code, body.data.message, res.status)
    : new ApiError("INTERNAL", "Something went wrong", res.status);
}
