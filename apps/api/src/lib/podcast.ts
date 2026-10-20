import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EpisodeRow } from "@fs/db";
import type { EpisodeView } from "@fs/schema";
import { Hono } from "hono";

/** Starts making an episode: a `podcast` message (one episode each). */
export interface PodcastQueue {
  start(episodeId: string): Promise<void>;
}

/** On AWS. Locally the dev runner finds queued episodes in the database instead. */
export function sqsPodcastQueue(queueUrl: string): PodcastQueue {
  const sqs = new SQSClient({});
  return {
    async start(episodeId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ episodeId }) }));
    },
  };
}

/** The podcast experiment as the API sees it: which episode to ask for, and where its audio is served. */
export interface PodcastConfig {
  format: "conversation" | "narration";
  promptVersion: string;
  voiceKey: string;
  /** Null locally, where the dev runner picks queued episodes up. */
  queue: PodcastQueue | null;
  /** Where the app fetches an episode's file: CloudFront on AWS, /podcast/audio on a local API. */
  audioUrl(key: string): string;
}

const MAKING: EpisodeRow["status"][] = ["queued", "scripting", "voicing"];

export function episodeView(row: EpisodeRow, audioUrl: (key: string) => string, now = Date.now()): EpisodeView {
  const ready = row.status === "ready" && row.audioKey;
  const making = MAKING.includes(row.status) && row.startedAt;
  return {
    id: row.id,
    status: row.status,
    format: (row.script?.format ?? row.format) as EpisodeView["format"],
    audioUrl: ready ? audioUrl(row.audioKey!) : null,
    durationSeconds: ready ? row.durationSeconds : null,
    chapters: ready ? (row.chapters ?? []) : [],
    progress: ready ? 1 : Math.max(0, Math.min(1, row.progress ?? 0)),
    // Measured here, so the app's estimate doesn't depend on the phone's clock agreeing with the server's.
    elapsedSeconds: making ? Math.max(0, Math.round((now - row.startedAt!.getTime()) / 100) / 10) : null,
  };
}

const TYPES: Record<string, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav" };

/**
 * Local development only: serves the dev runner's episode files at
 * /podcast/audio/<key>, with byte ranges (iOS's player asks for them). The
 * files are shared episodes with unguessable keys, like the images bucket on
 * AWS, so there's no sign-in check.
 */
export function localAudioRoutes(dir: string) {
  const root = resolve(dir);
  return new Hono().get("/audio/*", async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^.*?\/audio\//, ""));
    const path = resolve(join(root, key));
    const type = TYPES[path.split(".").pop() ?? ""];
    if (!path.startsWith(`${root}/`) || !type) return c.notFound();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return c.notFound();

    const size = info.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
      if (!range[1] && range[2]) start = Math.max(0, size - Number(range[2]));
      if (start > end || start >= size) return c.body(null, 416, { "content-range": `bytes */${size}` });
    }
    const file = await open(path);
    try {
      const body = Buffer.alloc(end - start + 1);
      await file.read(body, 0, body.length, start);
      const headers = { "content-type": type, "accept-ranges": "bytes", "content-length": String(body.length), "cache-control": "public, max-age=31536000, immutable" };
      return range
        ? c.body(new Uint8Array(body), 206, { ...headers, "content-range": `bytes ${start}-${end}/${size}` })
        : c.body(new Uint8Array(body), 200, headers);
    } finally {
      await file.close();
    }
  });
}
