import { z } from "zod";

export interface TranscriptSegment {
  text: string;
  /** Milliseconds from the start of the video. */
  offsetMs: number;
  durationMs: number;
}

export interface Transcript {
  segments: TranscriptSegment[];
  provider: string;
  /** `native` captions published with the video, or `generated` by AI transcription. */
  kind: "native" | "generated";
  language: string | null;
  /** 0–1 where the provider reports it; null when unknown. */
  confidence: number | null;
}

/** Swappable so a backup (TranscriptAPI.com, Apify) can replace Supadata (build plan §6.3). */
export interface TranscriptProvider {
  readonly name: string;
  /** Null when the video has no usable transcript. Throws on provider errors, so the caller can retry. */
  get(videoId: string, options?: { allowGenerated?: boolean; language?: string }): Promise<Transcript | null>;
}

/** Below this, a transcript is too unreliable to summarize from. */
export const MIN_TRANSCRIPT_CONFIDENCE = 0.6;

export function isUsableTranscript(t: Transcript | null): t is Transcript {
  if (!t || t.segments.length === 0) return false;
  return t.confidence === null || t.confidence >= MIN_TRANSCRIPT_CONFIDENCE;
}

export function transcriptText(t: Pick<Transcript, "segments">): string {
  return t.segments.map((s) => s.text).join(" ");
}

const chunkSchema = z.object({
  text: z.string(),
  offset: z.number(),
  duration: z.number(),
  lang: z.string().optional(),
});
const transcriptResponseSchema = z.object({
  content: z.array(chunkSchema),
  lang: z.string().nullish(),
});
const jobResponseSchema = z.object({ jobId: z.string() });

export interface SupadataOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** How long to wait for an AI-generation job before giving up for this attempt. */
  jobPollAttempts?: number;
  jobPollIntervalMs?: number;
}

/**
 * Supadata (https://docs.supadata.ai): native captions cost 1 credit; AI
 * generation costs 2 credits per minute and is only used when allowed.
 */
export function supadataProvider({
  apiKey,
  baseUrl = "https://api.supadata.ai/v1",
  fetch = globalThis.fetch,
  jobPollAttempts = 10,
  jobPollIntervalMs = 3_000,
}: SupadataOptions): TranscriptProvider {
  const headers = { "x-api-key": apiKey, accept: "application/json" };

  async function request(url: string) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    // 206: the video has no transcript in the requested mode. 404: unknown video.
    if (res.status === 206 || res.status === 404) return { status: res.status, body: null };
    if (!res.ok) throw new Error(`Supadata ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { status: res.status, body: (await res.json()) as unknown };
  }

  return {
    name: "supadata",
    async get(videoId, { allowGenerated = false, language } = {}) {
      const mode = allowGenerated ? "auto" : "native";
      const params = new URLSearchParams({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        mode,
        text: "false",
        chunkSize: "1000",
      });
      if (language) params.set("lang", language);

      let { status, body } = await request(`${baseUrl}/transcript?${params}`);
      if (status === 202) {
        const { jobId } = jobResponseSchema.parse(body);
        body = null;
        for (let i = 0; i < jobPollAttempts && body === null; i++) {
          await new Promise((r) => setTimeout(r, jobPollIntervalMs));
          const poll = await request(`${baseUrl}/transcript/${encodeURIComponent(jobId)}`);
          const job = poll.body as { status?: string } | null;
          if (job?.status === "failed") return null;
          if (transcriptResponseSchema.safeParse(job).success) body = job;
        }
        // Still running: throw so the queue retries later rather than recording "no transcript".
        if (body === null) throw new Error(`Supadata job ${jobId} for ${videoId} didn't finish in time`);
      }
      if (body === null) return null;

      const parsed = transcriptResponseSchema.parse(body);
      return {
        segments: parsed.content
          .map((c) => ({ text: c.text.trim(), offsetMs: c.offset, durationMs: c.duration }))
          .filter((s) => s.text),
        provider: "supadata",
        // A native-mode request can only return existing captions.
        kind: mode === "native" ? "native" : "generated",
        language: parsed.lang ?? parsed.content[0]?.lang ?? null,
        confidence: null,
      };
    },
  };
}
