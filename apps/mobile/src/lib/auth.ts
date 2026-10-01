import { expoClient } from "@better-auth/expo/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { API_URL, APP_SCHEME } from "./config";

/**
 * Better Auth against our API (/api/auth). On iOS and Android the session
 * cookie is kept in SecureStore; on web the browser keeps it.
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: APP_SCHEME, storagePrefix: APP_SCHEME, storage: SecureStore }), emailOTPClient()],
  fetchOptions: Platform.OS === "web" ? { credentials: "include" } : undefined,
});

/** Headers that authenticate a request to our API (empty on web, where the browser sends the cookie). */
export async function authHeaders(): Promise<Record<string, string>> {
  if (Platform.OS === "web") return {};
  const cookie = await authClient.getCookie();
  return cookie ? { cookie } : {};
}
