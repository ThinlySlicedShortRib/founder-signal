import Constants from "expo-constants";
import { Platform } from "react-native";

const DEV_API_PORT = 8787;

/**
 * Where the API lives. Release builds set EXPO_PUBLIC_API_URL per EAS profile.
 * In development the API runs on the same machine as the Expo dev server, so
 * a phone or emulator reaches it at the dev server's host.
 */
function resolveApiUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (Platform.OS === "web") return `http://localhost:${DEV_API_PORT}`;
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:${DEV_API_PORT}`;
  return Platform.OS === "android" ? `http://10.0.2.2:${DEV_API_PORT}` : `http://localhost:${DEV_API_PORT}`;
}

export const API_URL = resolveApiUrl();
export const APP_SCHEME = "foundersignal";
export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
