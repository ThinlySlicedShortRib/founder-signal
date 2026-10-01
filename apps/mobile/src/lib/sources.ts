import type { SourceMode, SourceType, SourceView, UpdateSourceInput } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./api";

const KEY = ["me", "sources"] as const;

export function useSources() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await unwrap(api.me.sources.$get())).sources,
  });
}

export function useSource(id: string) {
  const query = useSources();
  return { ...query, data: query.data?.find((s) => s.id === id) };
}

export function useAddSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { url: string; mode: SourceMode }) => (await unwrap(api.me.sources.$post({ json: input }))).source,
    onSuccess: (source) => {
      qc.setQueryData<SourceView[]>(KEY, (list) => [...(list ?? []).filter((s) => s.id !== source.id), source]);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateSource(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateSourceInput) =>
      (await unwrap(api.me.sources[":id"].$patch({ param: { id }, json: input }))).source,
    // Optimistic: mode and pause switches should feel instant.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: KEY });
      const previous = qc.getQueryData<SourceView[]>(KEY);
      qc.setQueryData<SourceView[]>(KEY, (list) => list?.map((s) => (s.id === id ? { ...s, ...input } : s)));
      return { previous };
    },
    onError: (_err, _input, ctx) => qc.setQueryData(KEY, ctx?.previous),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(api.me.sources[":id"].$delete({ param: { id } }));
      return id;
    },
    onSuccess: (id) => {
      qc.setQueryData<SourceView[]>(KEY, (list) => list?.filter((s) => s.id !== id));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export const MODE_OPTIONS: readonly { value: SourceMode; title: string; description: string }[] = [
  { value: "more_like_this", title: "More like this", description: "Learn from it, and mix its pieces in with everything else." },
  { value: "follow_closely", title: "Follow closely", description: "Prefer its new pieces when they fit your goals." },
  { value: "occasional", title: "Now and then", description: "Only its standout pieces." },
];

export const TYPE_LABEL: Record<SourceType, string> = {
  feed: "Feed",
  url: "Single page",
  youtube_channel: "YouTube channel",
};

export const TYPE_ICON = { feed: "newspaper-outline", url: "document-text-outline", youtube_channel: "logo-youtube" } as const;

export function rightsLabel(rights: SourceView["rights"]): string {
  if (rights.display === "link_only") return "Link only";
  if (rights.display === "excerpt_only") return "Digest only";
  return rights.offlineAllowed ? "Full text · offline" : "Full text";
}

export type FetchHealth = { tone: "neutral" | "accent" | "warning"; label: string };

export function fetchHealth(source: SourceView): FetchHealth {
  const status = source.lastFetchStatus;
  if (!status) return { tone: "neutral", label: source.type === "url" ? "Waiting to be read" : "Waiting for first check" };
  if (status === "ok" || status === "not_modified") {
    return { tone: "accent", label: source.lastFetchedAt ? `Checked ${timeAgo(source.lastFetchedAt)}` : "Up to date" };
  }
  const reason: Record<string, string> = {
    not_a_feed: "The feed can't be read",
    youtube_unavailable: "YouTube isn't set up",
    fetch_blocked_address: "That address isn't allowed",
    fetch_timeout: "The site is slow to answer",
  };
  return { tone: "warning", label: reason[status] ?? (status.startsWith("http_") ? `The site returned an error (${status.slice(5)})` : "Having trouble reaching it") };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
