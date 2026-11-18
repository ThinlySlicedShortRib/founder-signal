import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { createPodcastLibrary, type LibraryStorage } from "./podcast-library";

/**
 * The Podcasts tab's list (podcast-library.ts), kept on the device: one JSON
 * file per signed-in user in the app's documents (localStorage on web). It's
 * a convenience, like where you left off in a letter: if it can't be read,
 * the tab starts empty.
 */

export const podcastLibrary = createPodcastLibrary();

function storageFor(userId: string): LibraryStorage {
  const name = `podcasts-${userId.replace(/[^\w-]/g, "_")}.json`;
  if (Platform.OS === "web") {
    return {
      load: () => globalThis.localStorage?.getItem(`fs.${name}`) ?? null,
      save: (json) => globalThis.localStorage?.setItem(`fs.${name}`, json),
    };
  }
  const file = () => new File(Paths.document, name);
  return {
    load: () => {
      try {
        const f = file();
        return f.exists ? f.textSync() : null;
      } catch {
        return null;
      }
    },
    save: (json) => {
      try {
        const f = file();
        if (!f.exists) f.create();
        f.write(json);
      } catch {
        // Not worth surfacing.
      }
    },
  };
}

let openFor: string | null | undefined;
/** The signed-in user changed (the root layout says): their own list. */
export function openPodcastLibrary(userId: string | null) {
  if (userId === openFor) return;
  openFor = userId;
  podcastLibrary.open(userId ? storageFor(userId) : null);
}

const subscribe = (l: () => void) => podcastLibrary.subscribe(l);
/** The list, newest first. */
export function usePodcastLibrary() {
  return useSyncExternalStore(subscribe, podcastLibrary.entries);
}
/** One episode on the list (null: not on it). */
export function usePodcastEntry(itemId: string) {
  return useSyncExternalStore(subscribe, () => podcastLibrary.get(itemId));
}

// ── The pill's row on the Podcasts tab ────────────────────────────────────────
/**
 * The one agreed exception to now-playing.html: while the Library's Podcasts tab is showing, an episode being
 * made shows its progress in its own list row, so the pill's row is for playback only.
 */
let playbackOnly = false;
const modeListeners = new Set<() => void>();
export function setPillRowPlaybackOnly(on: boolean) {
  if (on === playbackOnly) return;
  playbackOnly = on;
  modeListeners.forEach((l) => l());
}
const subscribeMode = (l: () => void) => (modeListeners.add(l), () => void modeListeners.delete(l));
export function usePillRowPlaybackOnly() {
  return useSyncExternalStore(subscribeMode, () => playbackOnly);
}
