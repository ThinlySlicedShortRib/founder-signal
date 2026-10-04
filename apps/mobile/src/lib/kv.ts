import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * A few small values kept on the device (e.g. where the user left off in a
 * letter). SecureStore on iOS and Android, localStorage on web. Failures are
 * ignored: these are conveniences, never the source of truth.
 */
export async function kvGet(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Not worth surfacing.
  }
}
