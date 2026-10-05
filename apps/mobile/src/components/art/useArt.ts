import { useSyncExternalStore } from "react";
import { styleForDay, type StyleId } from "./styles";

/** Which art to draw: the style, and what its details are drawn from. */
export type ArtPick = { style: StyleId; seed: string; date: string; number: number | null };

// Dev tools can force one style on Today (in memory only, development builds only).
let forced: StyleId | null = null;
const listeners = new Set<() => void>();

export function setForcedStyle(style: StyleId | null) {
  forced = style;
  listeners.forEach((l) => l());
}

export function useForcedStyle(): StyleId | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => forced,
  );
}

/**
 * Today's art: the style the day picks (or the one Dev tools forced) and the
 * seed for its details, a letter's id or, before there's a letter, the day.
 */
export function useArt({ seed, date, number }: { seed: string; date: string; number: number | null }): ArtPick {
  const override = useForcedStyle();
  return { style: (__DEV__ && override) || styleForDay(date), seed, date, number };
}
