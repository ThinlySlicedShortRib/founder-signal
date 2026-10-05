import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterMark } from "@fs/core";

/**
 * Turns the stitched WAV into something small to stream: AAC in an .m4a at
 * 64 kbps mono (~0.5 MB a minute, plenty for speech). ffmpeg when there is
 * one (it also writes the chapters into the file, so podcast players show
 * them); otherwise macOS's built-in afconvert (no chapters in the file; the
 * app gets them from the API either way); otherwise the WAV as it is.
 */
export interface AudioEncoder {
  readonly name: "ffmpeg" | "afconvert" | "wav";
  encode(wav: Uint8Array, meta: EpisodeMeta): Promise<{ bytes: Uint8Array; contentType: string; ext: string }>;
}

export interface EpisodeMeta {
  title: string;
  artist: string;
  chapters: ChapterMark[];
  durationSeconds: number;
}

const BITRATE = 64_000;

export const wavEncoder: AudioEncoder = {
  name: "wav",
  async encode(wav) {
    return { bytes: wav, contentType: "audio/wav", ext: "wav" };
  },
};

export function afconvertEncoder(command = "afconvert"): AudioEncoder {
  return {
    name: "afconvert",
    encode: (wav) =>
      inTempDir(wav, async (input, dir) => {
        const out = join(dir, "episode.m4a");
        await run(command, ["-f", "m4af", "-d", "aac", "-b", String(BITRATE), input, out]);
        return { bytes: await readFile(out), contentType: "audio/mp4", ext: "m4a" };
      }),
  };
}

export function ffmpegEncoder(command = "ffmpeg"): AudioEncoder {
  return {
    name: "ffmpeg",
    encode: (wav, meta) =>
      inTempDir(wav, async (input, dir) => {
        const metaPath = join(dir, "meta.txt");
        const out = join(dir, "episode.m4a");
        await writeFile(metaPath, ffmetadata(meta));
        await run(command, ["-y", "-loglevel", "error", "-i", input, "-i", metaPath, "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", "-c:a", "aac", "-b:a", "64k", "-ac", "1", out]);
        return { bytes: await readFile(out), contentType: "audio/mp4", ext: "m4a" };
      }),
  };
}

/** ffmpeg's metadata file: title, artist and one [CHAPTER] per mark, in milliseconds. */
export function ffmetadata(meta: EpisodeMeta): string {
  const esc = (s: string) => s.replace(/([=;#\\\n])/g, "\\$1");
  const ms = (s: number) => Math.round(s * 1000);
  const lines = [";FFMETADATA1", `title=${esc(meta.title)}`, `artist=${esc(meta.artist)}`];
  meta.chapters.forEach((c, i) => {
    const end = meta.chapters[i + 1]?.startSeconds ?? meta.durationSeconds;
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${ms(c.startSeconds)}`, `END=${ms(end)}`, `title=${esc(c.title)}`);
  });
  return `${lines.join("\n")}\n`;
}

/** The best encoder available here: FFMPEG_PATH or ffmpeg on the PATH, then afconvert (macOS), then WAV. */
export async function pickEncoder({ ffmpegPath }: { ffmpegPath?: string } = {}): Promise<AudioEncoder> {
  if (await works(ffmpegPath ?? "ffmpeg", ["-version"])) return ffmpegEncoder(ffmpegPath ?? "ffmpeg");
  if (process.platform === "darwin" && (await works("afconvert", ["-h"]))) return afconvertEncoder();
  return wavEncoder;
}

async function inTempDir<T>(wav: Uint8Array, fn: (input: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fs-encode-"));
  try {
    const input = join(dir, "episode.wav");
    await writeFile(input, wav);
    return await fn(input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err = (err + d).slice(-1000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${err.trim()}`))));
  });
}

/** afconvert -h exits non-zero but runs; only a missing binary counts as not working. */
function works(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}
