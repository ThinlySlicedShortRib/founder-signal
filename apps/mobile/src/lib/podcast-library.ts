import type { NowPlayingMeta } from "./now-playing.ts";

/**
 * The Library's Podcasts tab (library-podcasts.html): every episode this
 * reader has asked for or played, with where they are in it. Plain
 * TypeScript (no React Native), so it can be tested on its own; `podcasts.ts`
 * keeps it in a file on the device and `listen.ts` feeds it from the player.
 *
 * Episodes are shared per piece on the server, which only knows who asked for
 * one first, so the list and the listening position live on the device. The
 * episode itself (status, progress while making, length) comes from the
 * server as before (`useEpisode`).
 */

export type LibraryEpisode = {
  itemId: string;
  title: string;
  /** The author, or the source for a piece outside a letter. */
  author: string | null;
  letterNumber: number | null;
  position: number | null;
  /** Where tapping the row goes (a letter's `today` is worked out again when it's opened). */
  home: NowPlayingMeta["home"];
  /** When it was first asked for or played (ms): the list is newest first. */
  addedAt: number;
  /** Where the reader is in it (seconds), and its length once known. */
  at: number;
  duration: number;
  /** Played to the end (and not started again since). */
  listened: boolean;
};

export type PodcastGroup = "progress" | "new" | "done";

/** In progress (part-way), New (not started, being made or failed), Listened. */
export function groupOf(e: Pick<LibraryEpisode, "at" | "listened">): PodcastGroup {
  if (e.listened) return "done";
  return e.at > STARTED_AT ? "progress" : "new";
}

/** Below this many seconds in, it hasn't really been started. */
export const STARTED_AT = 1;
/** Within this many seconds of the end, a saved position counts as the end (play starts again from the top). */
export const END_SLACK = 2;
/** While playing, the position is written down at most this often. */
export const SAVE_EVERY_MS = 5000;

/** Where to resume from: the saved spot, unless it's not started, listened or right at the end. */
export function resumeAt(e: Pick<LibraryEpisode, "at" | "duration" | "listened"> | null | undefined): number {
  if (!e || e.listened || e.at <= STARTED_AT) return 0;
  if (e.duration && e.at >= e.duration - END_SLACK) return 0;
  return e.at;
}

export type LibraryStorage = { load: () => string | null; save: (json: string) => void };

type Meta = Pick<NowPlayingMeta, "itemId" | "title" | "home" | "author" | "letterNumber" | "position">;

export type PodcastLibrary = ReturnType<typeof createPodcastLibrary>;

export function createPodcastLibrary(now: () => number = Date.now) {
  let storage: LibraryStorage | null = null;
  let list: LibraryEpisode[] = [];
  let lastSave = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  function persist() {
    lastSave = now();
    storage?.save(JSON.stringify(list));
  }
  function put(itemId: string, patch: Partial<LibraryEpisode>, { save = true, notify = true } = {}) {
    const i = list.findIndex((e) => e.itemId === itemId);
    if (i < 0) return;
    list = list.map((e, j) => (j === i ? { ...e, ...patch } : e));
    if (save) persist();
    if (notify) emit();
  }
  const details = (m: Meta) => ({
    title: m.title,
    author: m.author ?? null,
    letterNumber: m.letterNumber ?? null,
    position: m.position ?? null,
    home: m.home,
  });

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    /** Newest first (the same array until something changes). */
    entries: () => list,
    get: (itemId: string) => list.find((e) => e.itemId === itemId) ?? null,
    /** Whose list this is (null: signed out, kept in memory only). Loads it from storage. */
    open(s: LibraryStorage | null) {
      storage = s;
      list = [];
      try {
        const raw = s?.load();
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) list = (parsed as LibraryEpisode[]).filter((e) => e && typeof e.itemId === "string").sort((a, b) => b.addedAt - a.addedAt);
      } catch {
        list = [];
      }
      emit();
    },
    /** Asked for or played: it's on the list (once, at the top the first time). */
    remember(m: Meta) {
      const was = list.find((e) => e.itemId === m.itemId);
      if (was) return put(m.itemId, details(m));
      list = [{ itemId: m.itemId, ...details(m), addedAt: now(), at: 0, duration: 0, listened: false }, ...list];
      persist();
      emit();
    },
    /** Its reader showed: keep the title and letter details current. */
    describe(m: Meta) {
      const was = list.find((e) => e.itemId === m.itemId);
      if (!was) return;
      const next = details(m);
      if (JSON.stringify(next) === JSON.stringify(details(was))) return;
      put(m.itemId, next);
    },
    /**
     * The player's position. Written down when it pauses and every few seconds while it plays; the list only
     * re-renders when it's written (it never needs the live time: the playing row reads the player's).
     */
    progress(itemId: string, at: number, duration: number, playing: boolean) {
      const e = list.find((x) => x.itemId === itemId);
      if (!e) return;
      // Listened, and the player still sits at the end: that's not a new start.
      const length = duration || e.duration;
      if (e.listened && length && at >= length - END_SLACK) return;
      const started = at > STARTED_AT;
      const listened = e.listened && !started;
      const changed = Math.abs(e.at - at) >= 0.5 || (duration > 0 && duration !== e.duration) || listened !== e.listened;
      if (!changed) return;
      const due = !playing || listened !== e.listened || now() - lastSave >= SAVE_EVERY_MS;
      put(itemId, { at, duration: duration || e.duration, listened }, { save: due, notify: due });
    },
    /** Played to the end. */
    finished(itemId: string) {
      put(itemId, { listened: true, at: 0 });
    },
    /** Stopped while it was being made: it was never made, so it leaves the list. */
    forget(itemId: string) {
      if (!list.some((e) => e.itemId === itemId)) return;
      list = list.filter((e) => e.itemId !== itemId);
      persist();
      emit();
    },
  };
}

/** The groups as the tab opens (rows keep their group while it's open; they regroup next time). */
export function snapshotGroups(list: readonly LibraryEpisode[]): Record<string, PodcastGroup> {
  return Object.fromEntries(list.map((e) => [e.itemId, groupOf(e)]));
}

/** "Maya Okafor · No. 14 · Piece 2" (the parts it has). */
export function rowMeta(e: Pick<LibraryEpisode, "author" | "letterNumber" | "position">): string {
  return [e.author, e.letterNumber != null ? `No. ${e.letterNumber}` : null, e.position != null ? `Piece ${e.position}` : null].filter(Boolean).join(" · ");
}
