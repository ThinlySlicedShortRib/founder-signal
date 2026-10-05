import type { StitchPlan } from "@fs/core";

/**
 * Mono 16-bit PCM WAV, the format every voice returns clips in: read a clip,
 * write the stitched episode, and measure silence for the objective checks.
 */

export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/** Reads a mono 16-bit PCM WAV. Other layouts throw: the voices are asked for exactly this. */
export function parseWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let sampleRate = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error(`Unsupported WAV: format ${format}, ${channels} channels, ${bits} bits`);
    } else if (id === "data") {
      if (!sampleRate) throw new Error("WAV data before fmt");
      const length = Math.min(size, bytes.byteLength - body) >> 1;
      const samples = new Int16Array(length);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { sampleRate, samples };
    }
    at = body + size + (size & 1);
  }
  throw new Error("WAV has no data");
}

export function encodeWav({ sampleRate, samples }: Pcm): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}

/** Writes each clip at its offset in the plan; the gaps stay silent. */
export function renderPlan(clips: readonly Int16Array[], plan: StitchPlan, sampleRate: number): Pcm {
  const samples = new Int16Array(plan.totalSamples);
  clips.forEach((clip, i) => samples.set(clip.subarray(0, Math.max(0, plan.totalSamples - plan.offsets[i]!)), plan.offsets[i]!));
  return { sampleRate, samples };
}

/**
 * The longest run of near-silence (|sample| under `threshold` in every 10ms
 * window) and how much of the audio is silent: the objective "no dead air"
 * check, since nobody listens before an episode is shared.
 */
export function silenceStats({ sampleRate, samples }: Pcm, threshold = 200): { longestSeconds: number; silentFraction: number } {
  const window = Math.max(1, Math.round(sampleRate / 100));
  let run = 0;
  let longest = 0;
  let silent = 0;
  let windows = 0;
  for (let start = 0; start < samples.length; start += window) {
    let peak = 0;
    const end = Math.min(samples.length, start + window);
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]!));
    windows++;
    if (peak < threshold) {
      silent++;
      run += end - start;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { longestSeconds: Math.round((longest / sampleRate) * 100) / 100, silentFraction: windows ? Math.round((silent / windows) * 1000) / 1000 : 0 };
}

/** Linear resampling, for a clip whose rate differs from the episode's (rare: one engine per episode). */
export function resample(pcm: Pcm, sampleRate: number): Pcm {
  if (pcm.sampleRate === sampleRate) return pcm;
  const ratio = pcm.sampleRate / sampleRate;
  const out = new Int16Array(Math.floor(pcm.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const a = pcm.samples[j] ?? 0;
    const b = pcm.samples[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return { sampleRate, samples: out };
}
