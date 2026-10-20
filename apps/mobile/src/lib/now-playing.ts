import type { EpisodeView } from "@fs/schema";
import { phaseOf, type Phase, type PlayState, rowShows, type TaskLocal } from "./episode-task.ts";

/**
 * Now playing (now-playing.html): which piece's episode the pill's status row
 * carries, app-wide. Plain TypeScript (no React Native), so it can be tested
 * on its own; `listen.ts` wires it to the one audio player and the lock screen.
 *
 * One episode at a time owns the row (the "subject"). It takes the row when
 * it's asked for (making starts) or played, from any screen, and keeps it
 * while you move around the app: the row never folds or regrows on a change
 * of screen. Another episode starting replaces it in place (the row
 * crossfades). It lets go only when its row has folded (after "Listened" or
 * "Stopped"); then the row falls back to the episode still in the player, if
 * that's another one, or goes.
 */

/** Where tapping the row's text goes, and what the lock screen says. */
export type NowPlayingMeta = {
  itemId: string;
  title: string;
  /** In a letter: that letter, at this piece's page. Otherwise the item's own reader. */
  home: { kind: "letter"; letterId: string; today: boolean; page: number } | { kind: "item" };
  /** Under the title on the lock screen: "Founder Signal · No. 14 · Piece 2". */
  subtitle: string;
  artworkUrl: string | null;
  /** For the Library's Podcasts tab: "Author · No. 14 · Piece 2" (the author, or the source outside a letter). */
  author?: string | null;
  letterNumber?: number | null;
  position?: number | null;
};

export type NowPlaying = ReturnType<typeof createNowPlaying>;

export function createNowPlaying() {
  let subject: string | null = null;
  /** The piece whose audio is loaded in the player (playing, paused or ended). */
  let playerItem: string | null = null;
  const metas = new Map<string, NowPlayingMeta>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    /** The piece whose episode the row shows, or null for no row. */
    subject: () => subject,
    playerItem: () => playerItem,
    meta: (id: string | null) => (id ? (metas.get(id) ?? null) : null),
    /** What a piece is (its reader says, when it shows). */
    describe(meta: NowPlayingMeta) {
      const was = metas.get(meta.itemId);
      if (was && JSON.stringify(was) === JSON.stringify(meta)) return;
      metas.set(meta.itemId, meta);
      if (meta.itemId === subject) emit();
    },
    /**
     * Making starts, or play is pressed: this episode takes the row. Returns the one it replaced (the row stays
     * open and crossfades to the new one), or null if the row was empty or already this one.
     */
    claim(id: string): string | null {
      if (subject === id) return null;
      const was = subject;
      subject = id;
      emit();
      return was;
    },
    /** The player loaded this piece's audio (the one the row falls back to). */
    loaded(id: string) {
      playerItem = id;
    },
    /** The subject's row folded away (Listened or Stopped, then gone). */
    folded(id: string) {
      if (subject !== id) return;
      subject = playerItem && playerItem !== id ? playerItem : null;
      emit();
    },
  };
}

/** What the row shows for the subject: its phase, and whether the row is open at all. */
export function rowOf(
  subject: string | null,
  server: Pick<EpisodeView, "status"> | null | undefined,
  local: TaskLocal,
  play: PlayState | null,
): { itemId: string; phase: Phase; open: boolean } | null {
  if (!subject) return null;
  const phase = phaseOf(server, local, play, subject);
  return { itemId: subject, phase, open: rowShows(phase, local) };
}

/** "Founder Signal · No. 14 · Piece 2" (or the source, for a piece outside a letter). */
export function lockSubtitle(letterNumber: number | null, position: number | null, source: string | null): string {
  if (letterNumber != null && position != null) return `Founder Signal · No. ${letterNumber} · Piece ${position}`;
  return ["Founder Signal", source].filter(Boolean).join(" · ");
}
