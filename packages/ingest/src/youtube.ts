import { z } from "zod";
import type { YouTubeRef } from "./url.ts";

/**
 * Listings come from the YouTube Data API v3 (build plan §6.3). Captions do
 * not: the Data API only serves captions for videos you own, so transcripts
 * go through a TranscriptProvider instead.
 */

export interface YouTubeChannel {
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
}

export interface YouTubeVideo {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: Date | null;
}

export interface YouTubeClient {
  resolveChannel(ref: Exclude<YouTubeRef, { kind: "video" }>): Promise<YouTubeChannel | null>;
  /** Most recent uploads first. */
  listUploads(uploadsPlaylistId: string, max?: number): Promise<YouTubeVideo[]>;
  getVideo(videoId: string): Promise<YouTubeVideo | null>;
}

const channelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ title: z.string() }),
        contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string() }) }),
      }),
    )
    .optional(),
});

const snippetSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
  channelId: z.string(),
  channelTitle: z.string().default(""),
  publishedAt: z.string().optional(),
});

const playlistItemsSchema = z.object({
  items: z.array(
    z.object({
      snippet: snippetSchema,
      contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
    }),
  ),
});

const videosSchema = z.object({ items: z.array(z.object({ id: z.string(), snippet: snippetSchema })).optional() });

export function youTubeDataClient({
  apiKey,
  fetch = globalThis.fetch,
  baseUrl = "https://www.googleapis.com/youtube/v3",
}: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}): YouTubeClient {
  async function get(path: string, params: Record<string, string>) {
    const qs = new URLSearchParams({ ...params, key: apiKey });
    const res = await fetch(`${baseUrl}/${path}?${qs}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`YouTube Data API ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as unknown;
  }

  const toVideo = (videoId: string, s: z.infer<typeof snippetSchema>, publishedAt?: string): YouTubeVideo => {
    const date = publishedAt ?? s.publishedAt;
    return {
      videoId,
      channelId: s.channelId,
      channelTitle: s.channelTitle,
      title: s.title,
      description: s.description,
      publishedAt: date ? new Date(date) : null,
    };
  };

  return {
    async resolveChannel(ref) {
      const filter: Record<string, string> =
        ref.kind === "channel"
          ? { id: ref.channelId }
          : ref.kind === "handle"
            ? { forHandle: ref.handle }
            : { forUsername: ref.name };
      const body = channelsSchema.parse(await get("channels", { part: "snippet,contentDetails", ...filter }) ?? {});
      const item = body.items?.[0];
      if (!item) return null;
      return { channelId: item.id, title: item.snippet.title, uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads };
    },

    async listUploads(uploadsPlaylistId, max = 15) {
      const body = await get("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: String(Math.min(max, 50)),
      });
      if (!body) return [];
      return playlistItemsSchema
        .parse(body)
        .items.map((i) => toVideo(i.contentDetails.videoId, i.snippet, i.contentDetails.videoPublishedAt));
    },

    async getVideo(videoId) {
      const body = videosSchema.parse(await get("videos", { part: "snippet", id: videoId }) ?? {});
      const item = body.items?.[0];
      return item ? toVideo(item.id, item.snippet) : null;
    },
  };
}
