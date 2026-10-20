import type { EpisodeView } from "@fs/schema";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { API_URL } from "./config";
import { isBusy } from "./episode-task";

/**
 * The podcast experiment: a piece as a short audio episode. Asking for one
 * queues it on the workers; the episode is polled while it's being made (its
 * `progress` drives the ring), and Stop deletes it. The task around it (what
 * the pill, the card and the headphones show) is in `listen.ts`.
 */

export const episodeKey = (itemId: string) => ["items", itemId, "episode"] as const;
export type EpisodeResponse = { episode: EpisodeView | null; available: boolean };

export const isMaking = (e: EpisodeView | null | undefined) => isBusy(e);

/** A local API returns a path; on AWS it's a CloudFront URL. */
export const episodeAudioUrl = (e: EpisodeView) => (e.audioUrl?.startsWith("/") ? `${API_URL}${e.audioUrl}` : e.audioUrl);

export function useEpisode(itemId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: episodeKey(itemId),
    queryFn: async () => await unwrap(api.items[":id"].episode.$get({ param: { id: itemId } })),
    enabled,
    // Making one takes a minute or two (longer on a busy laptop); often enough for the ring to move.
    refetchInterval: (q) => (isMaking(q.state.data?.episode) ? POLL_MS : false),
  });
}

/** How often a making episode is polled; the ring eases over this long to each new number. */
export const POLL_MS = 2_000;

export async function requestEpisode(itemId: string): Promise<EpisodeView> {
  return (await unwrap(api.items[":id"].episode.$post({ param: { id: itemId } }))).episode;
}

/** Stop: the API deletes the episode if it's still being made (and this user asked for it); the worker stops at its next step. */
export async function cancelEpisode(itemId: string): Promise<{ cancelled: boolean; episode: EpisodeView | null }> {
  return await unwrap(api.items[":id"].episode.$delete({ param: { id: itemId } }));
}
