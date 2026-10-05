import type { EpisodeView } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { API_URL } from "./config";

/**
 * The podcast experiment: a piece as a short audio episode. Asking for one
 * queues it on the workers; the episode is polled while it's being made.
 */

const episodeKey = (itemId: string) => ["items", itemId, "episode"] as const;
const BUSY: EpisodeView["status"][] = ["queued", "scripting", "voicing"];

export const isMaking = (e: EpisodeView | null | undefined) => !!e && BUSY.includes(e.status);

/** A local API returns a path; on AWS it's a CloudFront URL. */
export const episodeAudioUrl = (e: EpisodeView) => (e.audioUrl?.startsWith("/") ? `${API_URL}${e.audioUrl}` : e.audioUrl);

export function useEpisode(itemId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: episodeKey(itemId),
    queryFn: async () => await unwrap(api.items[":id"].episode.$get({ param: { id: itemId } })),
    enabled,
    // Making one takes a minute or two (longer on a busy laptop).
    refetchInterval: (q) => (isMaking(q.state.data?.episode) ? 4_000 : false),
  });
}

export function useRequestEpisode(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.items[":id"].episode.$post({ param: { id: itemId } }))).episode,
    onSuccess: (episode) => qc.setQueryData(episodeKey(itemId), { episode, available: true }),
  });
}
