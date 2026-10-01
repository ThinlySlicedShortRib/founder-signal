// Imported by the Expo app. Type-only import keeps server code out of the app bundle.
import { hc } from "hono/client";
import type { AppType } from "./app.ts";

export type { AppType };

export function createApiClient(baseUrl: string, options?: Parameters<typeof hc>[1]) {
  return hc<AppType>(baseUrl, options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
