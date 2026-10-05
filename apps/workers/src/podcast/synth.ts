import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { EPISODE_VOICES, type EpisodeSpeaker, type TtsEngine } from "@fs/core";
import { type Pcm, parseWav } from "./wav.ts";

/**
 * A voice for podcast episodes. Locally that's Kokoro-82M (open weights,
 * Apache-2.0) in a long-lived Python process on this machine, so it costs
 * nothing; on AWS it's Amazon Polly's neural voices, in the project's Region.
 */
export interface SpeechSynth {
  readonly engine: TtsEngine;
  readonly model: string;
  /** Key into @fs/core `TTS_PRICES`. */
  readonly priceKey: string;
  voiceFor(speaker: EpisodeSpeaker): string;
  /** One chunk of speech (see @fs/core `splitForSpeech`) as mono 16-bit PCM. */
  synthesize(text: string, speaker: EpisodeSpeaker): Promise<Pcm>;
  close(): Promise<void>;
}

// ── Kokoro, locally ──────────────────────────────────────────────────────────

type KokoroReply = { id?: string; ok?: boolean; error?: string; ready?: boolean };

/**
 * Kokoro through apps/workers/tts/kokoro_server.py, started on first use with
 * `uv run` (which builds the venv the first time) and kept running, so the
 * model loads once per worker. Requests go one per line; replies come back in
 * order, each clip in a temp WAV.
 */
export function kokoroSynth({
  ttsDir = join(import.meta.dirname, "..", "..", "tts"),
  uv = "uv",
  timeoutMs = 120_000,
  log = () => {},
}: { ttsDir?: string; uv?: string; timeoutMs?: number; log?: (event: string, data?: Record<string, unknown>) => void } = {}): SpeechSynth {
  const voices = EPISODE_VOICES.kokoro;
  let proc: Promise<{ child: ChildProcessWithoutNullStreams; dir: string }> | undefined;
  const waiting = new Map<string, { resolve: (r: KokoroReply) => void; reject: (e: Error) => void }>();
  let next = 0;

  const failAll = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    proc = undefined;
  };

  const start = () =>
    new Promise<{ child: ChildProcessWithoutNullStreams; dir: string }>((resolve, reject) => {
      const child = spawn(uv, ["run", "--frozen", "--project", ttsDir, "python", join(ttsDir, "kokoro_server.py")], { cwd: ttsDir, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-2000)));
      child.on("error", (e) => {
        reject(new Error(`Couldn't start the Kokoro server (${uv}): ${e.message}`));
        failAll(e);
      });
      child.on("exit", (code) => {
        const err = new Error(`Kokoro server exited (${code}): ${stderr.trim().slice(-500)}`);
        reject(err);
        failAll(err);
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let msg: KokoroReply;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.ready) {
          void mkdtemp(join(tmpdir(), "fs-podcast-")).then((dir) => {
            log("kokoro_ready");
            resolve({ child, dir });
          }, reject);
          return;
        }
        const w = msg.id ? waiting.get(msg.id) : undefined;
        if (!w) return;
        waiting.delete(msg.id!);
        w.resolve(msg);
      });
    });

  return {
    engine: "kokoro",
    model: voices.model,
    priceKey: "kokoro",
    voiceFor: (speaker) => voices[speaker],
    async synthesize(text, speaker) {
      proc ??= start();
      const { child, dir } = await proc;
      const id = String(++next);
      const out = join(dir, `${id}.wav`);
      const reply = await new Promise<KokoroReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("Kokoro timed out"));
        }, timeoutMs);
        waiting.set(id, {
          resolve: (r) => (clearTimeout(timer), resolve(r)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        child.stdin.write(`${JSON.stringify({ id, text, voice: voices[speaker], speed: 1.0, lang: "en-us", out })}\n`);
      });
      if (!reply.ok) throw new Error(`Kokoro failed: ${reply.error ?? "unknown"}`);
      try {
        return parseWav(await readFile(out));
      } finally {
        await rm(out, { force: true });
      }
    },
    async close() {
      const p = proc;
      proc = undefined;
      if (!p) return;
      const { child, dir } = await p.catch(() => ({ child: null, dir: null }));
      child?.stdin.end();
      child?.kill();
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

// ── Polly, on AWS ────────────────────────────────────────────────────────────

/** Polly's PCM output: mono 16-bit little-endian, at most 16 kHz. */
export const POLLY_SAMPLE_RATE = 16_000;

type PollyLike = Pick<PollyClient, "send">;

/**
 * Amazon Polly neural voices in the project's Region (ap-southeast-2 has
 * them). PCM out, so clips stitch without decoding; 16 kHz is Polly's PCM
 * ceiling, plenty for speech.
 */
export function pollySynth({ client = new PollyClient({}) as PollyLike }: { client?: PollyLike } = {}): SpeechSynth {
  const voices = EPISODE_VOICES.polly;
  return {
    engine: "polly",
    model: voices.model,
    priceKey: "polly-neural",
    voiceFor: (speaker) => voices[speaker],
    async synthesize(text, speaker) {
      const res = await client.send(
        new SynthesizeSpeechCommand({ Engine: "neural", OutputFormat: "pcm", SampleRate: String(POLLY_SAMPLE_RATE), TextType: "text", Text: text, VoiceId: voices[speaker] }),
      );
      if (!res.AudioStream) throw new Error("Polly returned no audio");
      const bytes = await res.AudioStream.transformToByteArray();
      const samples = new Int16Array(bytes.byteLength >> 1);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
      return { sampleRate: POLLY_SAMPLE_RATE, samples };
    },
    async close() {},
  };
}
