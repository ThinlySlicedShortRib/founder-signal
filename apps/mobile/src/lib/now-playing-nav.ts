import { router } from "expo-router";
import type { NowPlayingMeta } from "./now-playing";

/**
 * Tapping the row's text, from any screen: back to the piece. In a letter, that letter opens at the piece
 * with the article up and its Listen card flashing once; otherwise the item's reader, at its Listen card.
 * `listen` is a fresh nonce each time, so a second tap from the same place still flashes the card. Already
 * there, the params change in place (no new screen).
 */
export function goToNowPlaying(meta: NowPlayingMeta, pathname: string) {
  const listen = String(Date.now());
  const { home } = meta;
  if (home.kind === "item") {
    if (pathname === `/items/${meta.itemId}`) router.setParams({ listen });
    else router.push({ pathname: "/items/[id]", params: { id: meta.itemId, listen } });
    return;
  }
  const page = String(home.page);
  if (home.today) {
    // Today is one of the menu's destinations, so it replaces the screen like the menu does.
    if (pathname === "/") router.setParams({ page, listen });
    else router.replace({ pathname: "/", params: { page, listen } });
    return;
  }
  if (pathname === `/letters/${home.letterId}`) router.setParams({ page, listen });
  else router.push({ pathname: "/letters/[id]", params: { id: home.letterId, page, listen } });
}

/** The params a letter or item route was opened with by `goToNowPlaying` (null: opened some other way). */
export function listenParams(p: { page?: string | string[]; listen?: string | string[] }): { page: number | null; listen: number } | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const listen = Number(one(p.listen));
  if (!listen) return null;
  const page = Number(one(p.page));
  return { page: Number.isFinite(page) && page > 0 ? page : null, listen };
}

/**
 * "All episodes in Podcasts ›" in the pill's panel: the Library, on its Podcasts tab. Library is one of the menu's
 * destinations, so it replaces the screen like the menu does; already there, the tab changes in place. `tab` is
 * a fresh nonce each time, so it switches even if the reader moved to another tab since.
 */
export function goToPodcasts(pathname: string) {
  const params = { tab: "podcasts", at: String(Date.now()) };
  if (pathname === "/library") router.setParams(params);
  else router.replace({ pathname: "/library", params });
}
