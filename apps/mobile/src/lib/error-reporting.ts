import type { ClientLogEntry } from "@fs/schema";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { authHeaders } from "./auth";
import { API_URL, APP_VERSION } from "./config";

/**
 * JS error reporting to POST /client-logs → CloudWatch (build plan §8).
 * Reports wait in a small in-memory queue and are sent in batches. Native
 * crashes aren't caught here; they show up in TestFlight / the Play Console.
 * TODO(M4): persist the queue in SQLite with the offline outbox.
 */

const MAX_QUEUE = 50;
const FLUSH_DELAY_MS = 2_000;

const queue: ClientLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let currentContext: string | undefined;

/** Called on navigation so reports say which screen they came from. */
export function setErrorContext(context: string) {
  currentContext = context;
}

export function reportError(error: unknown, { fatal = false, context }: { fatal?: boolean; context?: string } = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  if (__DEV__) console.warn("[report]", err);
  queue.push({
    level: "error",
    message: `${err.name}: ${err.message}`.slice(0, 2_000),
    stack: err.stack?.slice(0, 16_000),
    context: (context ?? currentContext)?.slice(0, 200),
    fatal,
    occurredAt: new Date().toISOString(),
    app: {
      version: APP_VERSION,
      // Set from expo-updates once EAS Update is added (M7).
      updateId: null,
      platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web",
      osVersion: Device.osVersion ?? undefined,
    },
  });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  scheduleFlush(fatal ? 0 : FLUSH_DELAY_MS);
}

function scheduleFlush(delay: number) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

export async function flush() {
  if (!queue.length) return;
  const entries = queue.splice(0, MAX_QUEUE);
  try {
    const res = await fetch(`${API_URL}/client-logs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      credentials: Platform.OS === "web" ? "include" : "omit",
      body: JSON.stringify({ entries }),
    });
    // 4xx means the batch itself is bad (or we're rate-limited); don't loop on it.
    if (res.status >= 500) throw new Error(`client-logs ${res.status}`);
  } catch {
    queue.unshift(...entries.slice(0, MAX_QUEUE - queue.length));
    scheduleFlush(30_000);
  }
}

let installed = false;

/** Catches uncaught JS errors and unhandled promise rejections. */
export function installGlobalErrorHandlers() {
  if (installed) return;
  installed = true;

  if (Platform.OS === "web") {
    if (typeof window === "undefined") return;
    window.addEventListener("error", (e) => reportError(e.error ?? e.message, { fatal: false }));
    window.addEventListener("unhandledrejection", (e) => reportError(e.reason));
    return;
  }

  const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: Error, fatal?: boolean) => void; setGlobalHandler(h: (e: Error, fatal?: boolean) => void): void } }).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      reportError(error, { fatal: !!isFatal });
      previous(error, isFatal);
    });
  }
}
