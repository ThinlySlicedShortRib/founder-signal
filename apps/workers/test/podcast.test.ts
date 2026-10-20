import { randomUUID } from "node:crypto";
import type { EpisodeScriptWriter, ScriptInput, ScriptResult } from "@fs/ai";
import { type EpisodeScript, episodeVoiceKey } from "@fs/core";
import { cancelEpisode, createDb, requestEpisode, schema } from "@fs/db";
import type { Block } from "@fs/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { memoryContentStore } from "../src/lib/content-store.ts";
import { memoryQueues } from "../src/lib/queues.ts";
import type { PipelineDeps } from "../src/pipeline/deps.ts";
import { dispatch } from "../src/pipeline/dispatch.ts";
import { memoryAudioStore } from "../src/podcast/audio-store.ts";
import { PROGRESS, scriptProgress, voiceProgress } from "../src/podcast/generate.ts";
import { ffmetadata, wavEncoder } from "../src/podcast/encode.ts";
import { runQueuedEpisodes } from "../src/podcast/local.ts";
import type { SpeechSynth } from "../src/podcast/synth.ts";
import { encodeWav, parseWav, renderPlan, resample, silenceStats } from "../src/podcast/wav.ts";

const { contentItem, contentVersion, episode, publisher } = schema;

const { db, pool } = createDb({ connectionString: process.env.TEST_DATABASE_URL!, ssl: false });
afterAll(() => pool.end());

const RATE = 1000;
const PARAGRAPHS = ["We raised prices 3 times in 10 years.", "Churn fell to 2.5% after the change.", "Our first plan cost $49 a month."];
const blocks: Block[] = [{ type: "heading", level: 1, text: "Pricing" }, ...PARAGRAPHS.map((text) => ({ type: "paragraph" as const, text }))];

const talk = (words: number) => Array.from({ length: words }, () => "pricing").join(" ") + ".";
/** A conversation that passes the checks unless `extra` adds a problem. */
function goodScript(extra = ""): EpisodeScript {
  return {
    format: "conversation",
    chapters: [
      { title: "Opening", lines: [{ speaker: "host", text: `They raised prices 3 times. ${extra}` }, { speaker: "cohost", text: "Why?" }] },
      { title: "Close", lines: Array.from({ length: 7 }, (_, i) => ({ speaker: i % 2 ? ("cohost" as const) : ("host" as const), text: talk(50) })) },
    ],
  };
}

function fakeWriter(scripts: EpisodeScript[]) {
  const calls: ScriptInput[] = [];
  const writer: EpisodeScriptWriter = {
    method: "anthropic",
    model: "claude-sonnet-5-5",
    promptVersion: "podcast-script-v1",
    async write(input): Promise<ScriptResult> {
      calls.push(input);
      const script = scripts[Math.min(calls.length - 1, scripts.length - 1)]!;
      return { script, usage: { inputTokens: 2000, outputTokens: 1000 }, promptChars: 8000, outputChars: 4000 };
    },
  };
  return { writer, calls };
}

/** Each chunk becomes a tone, 10 samples per character, so durations are predictable. */
function fakeSynth({ failOn }: { failOn?: string } = {}): SpeechSynth & { spoken: { text: string; speaker: string }[] } {
  const spoken: { text: string; speaker: string }[] = [];
  return {
    engine: "kokoro",
    model: "kokoro-v1.0",
    priceKey: "kokoro",
    spoken,
    voiceFor: (s) => s,
    async synthesize(text, speaker) {
      if (failOn && text.includes(failOn)) throw new Error("voice broke");
      spoken.push({ text, speaker });
      return { sampleRate: RATE, samples: new Int16Array(text.length * 10).fill(8000) };
    },
    async close() {},
  };
}

async function seed({ rights = "full_text" }: { rights?: "full_text" | "excerpt_only" } = {}) {
  const [pub] = await db.insert(publisher).values({ key: `pub-${randomUUID()}`, name: "Test Blog", origin: "user_added" }).returning();
  const [item] = await db
    .insert(contentItem)
    .values({ canonicalUrl: `https://example.com/${randomUUID()}`, type: "article", publisherId: pub!.id, title: "10 years of pricing", authorName: "Ann Author", status: "extracted" })
    .returning();
  const { store } = memoryContentStore();
  const blocksKey = `items/${item!.id}/blocks-x.json`;
  await store.putJson(blocksKey, { blocks, sections: [] });
  await db.insert(contentVersion).values({
    itemId: item!.id,
    contentHash: "x",
    blocksKey,
    sectionMap: [],
    rightsSnapshot: { display: rights, retainText: true, offlineAllowed: true, licenseNote: null },
  });
  return { itemId: item!.id, store };
}

function depsFor(store: PipelineDeps["store"], writer: EpisodeScriptWriter | null, synth: SpeechSynth) {
  const audio = memoryAudioStore();
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const deps = {
    db,
    queues: memoryQueues().queues,
    store,
    podcast: { scriptWriter: writer, synth, audio: audio.store, encoder: wavEncoder },
    log: (event: string, data?: Record<string, unknown>) => events.push({ event, data }),
  } as unknown as PipelineDeps;
  return { deps, audio, events };
}

const identity = (itemId: string) => ({ itemId, format: "conversation", promptVersion: "podcast-script-v1", voiceKey: episodeVoiceKey("kokoro", "conversation"), userId: null });

beforeEach(async () => {
  await db.delete(episode);
});

describe("generateEpisode", () => {
  it("writes, checks, voices, stitches and stores an episode, once", async () => {
    const { itemId, store } = await seed();
    const { writer, calls } = fakeWriter([goodScript()]);
    const synth = fakeSynth();
    const { deps, audio } = depsFor(store, writer, synth);
    const { episode: row, queued } = (await requestEpisode(db, identity(itemId)))!;
    expect(queued).toBe(true);

    await dispatch(deps, "podcast", { episodeId: row.id });

    const [done] = await db.select().from(episode).where(eq(episode.id, row.id));
    expect(done).toMatchObject({ status: "ready", scriptMethod: "anthropic", scriptModel: "claude-sonnet-5-5", ttsEngine: "kokoro", audioType: "audio/wav", sampleRate: RATE, attempts: 1 });
    expect(calls[0]).toMatchObject({ format: "conversation", title: "10 years of pricing", author: "Ann Author", sourceName: "Test Blog", truncated: false });
    expect(calls[0]!.text).toContain("Churn fell to 2.5%");
    // Both voices were used, and the money and percentages were made speakable.
    expect(new Set(synth.spoken.map((s) => s.speaker))).toEqual(new Set(["host", "cohost"]));
    const stored = audio.objects.get(done!.audioKey!)!;
    expect(done!.audioKey).toBe(`podcast/items/${itemId}/${row.id}.wav`);
    const pcm = parseWav(stored.body);
    expect(pcm.samples.length / RATE).toBeCloseTo(done!.durationSeconds!, 1);
    expect(done!.chapters!.map((c) => c.title)).toEqual(["Opening", "Close"]);
    expect(done!.chapters![1]!.startSeconds).toBeGreaterThan(0);
    // 2000 input and 1000 output tokens on Sonnet 5.5; Kokoro is free.
    expect(done!.cost).toMatchObject({ scriptUsd: 0.014, ttsUsd: 0 });
    expect(silenceStats(pcm).longestSeconds).toBeLessThan(1);

    // Asking again returns the same, finished episode; a second message does nothing.
    expect(await requestEpisode(db, identity(itemId))).toMatchObject({ queued: false, episode: { id: row.id, status: "ready" } });
    expect(await dispatch(deps, "podcast", { episodeId: row.id })).toMatchObject({ status: "skipped" });
  });

  it("asks again with the problems, then reads the piece's own words if the script still fails", async () => {
    const { itemId, store } = await seed();
    const bad = goodScript("Churn fell 40% in 18 months.");
    const { writer, calls } = fakeWriter([bad, bad]);
    const { deps } = depsFor(store, writer, fakeSynth());
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;

    await dispatch(deps, "podcast", { episodeId: row.id });

    const [done] = await db.select().from(episode).where(eq(episode.id, row.id));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.problems).toEqual(expect.arrayContaining(["number_unsupported:40", "number_unsupported:18"]));
    expect(done).toMatchObject({ status: "ready", scriptMethod: "fallback" });
    expect(done!.script!.format).toBe("reading");
    expect(done!.script!.chapters[0]!.lines.map((l) => l.text)).toEqual(expect.arrayContaining(PARAGRAPHS));
    expect(done!.scriptProblems).toEqual(expect.arrayContaining(["1:number_unsupported:40", "2:number_unsupported:18"]));
    // The rejected attempts are still counted.
    expect(done!.cost!.inputTokens).toBe(4000);
  });

  it("reads the piece's own words with no script writer", async () => {
    const { itemId, store } = await seed();
    const { deps } = depsFor(store, null, fakeSynth());
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;
    await dispatch(deps, "podcast", { episodeId: row.id });
    const [done] = await db.select().from(episode).where(eq(episode.id, row.id));
    expect(done).toMatchObject({ status: "ready", scriptMethod: "fallback", scriptModel: null, costUsd: 0 });
  });

  it("marks a failure, and asking again queues it again", async () => {
    const { itemId, store } = await seed();
    const { writer } = fakeWriter([goodScript()]);
    const { deps, events } = depsFor(store, writer, fakeSynth({ failOn: "Why" }));
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;

    expect(await dispatch(deps, "podcast", { episodeId: row.id })).toMatchObject({ status: "failed", error: "voice broke" });
    expect(events.map((e) => e.event)).toContain("episode_failed");
    expect(await requestEpisode(db, identity(itemId))).toMatchObject({ queued: true, episode: { id: row.id, status: "queued", error: null } });
  });

  it("reports progress as it voices, chunk by chunk, and ends at 1", async () => {
    const { itemId, store } = await seed();
    const { writer } = fakeWriter([goodScript()]);
    const synth = fakeSynth();
    const { deps } = depsFor(store, writer, synth);
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;
    const seen: number[] = [];
    const inner = synth.synthesize.bind(synth);
    synth.synthesize = async (text, speaker) => {
      const [r] = await db.select({ status: episode.status, progress: episode.progress }).from(episode).where(eq(episode.id, row.id));
      expect(r!.status).toBe("voicing");
      seen.push(r!.progress);
      return inner(text, speaker);
    };

    await dispatch(deps, "podcast", { episodeId: row.id });
    expect(seen[0]).toBe(PROGRESS.script);
    // Never backwards, and short of done until the file is stored.
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(seen.at(-1)!).toBeLessThan(PROGRESS.voiced);
    const [done] = await db.select({ progress: episode.progress }).from(episode).where(eq(episode.id, row.id));
    expect(done!.progress).toBe(1);
    expect(scriptProgress(0)).toBe(0);
    expect(scriptProgress(10 * 60_000)).toBeLessThan(PROGRESS.script);
    expect(voiceProgress(3, 6)).toBeCloseTo(0.6);
  });

  it("stops when the episode is cancelled mid-way, leaving no file and no row", async () => {
    const { itemId, store } = await seed();
    const { writer } = fakeWriter([goodScript()]);
    const synth = fakeSynth();
    const { deps, audio, events } = depsFor(store, writer, synth);
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;
    const inner = synth.synthesize.bind(synth);
    synth.synthesize = async (text, speaker) => {
      // The reader taps Stop while the third chunk is being voiced.
      if (synth.spoken.length === 2) expect(await cancelEpisode(db, { ...identity(itemId), userId: "anyone" })).toMatchObject({ cancelled: true });
      return inner(text, speaker);
    };

    expect(await dispatch(deps, "podcast", { episodeId: row.id })).toMatchObject({ status: "skipped", error: "cancelled" });
    expect(synth.spoken).toHaveLength(3);
    expect(audio.objects.size).toBe(0);
    expect(await db.select().from(episode).where(eq(episode.id, row.id))).toHaveLength(0);
    expect(events.map((e) => e.event)).toContain("episode_cancelled");
    expect(events.map((e) => e.event)).not.toContain("episode_failed");
  });

  it("won't make an episode of a piece the app can't show in full", async () => {
    const { itemId, store } = await seed({ rights: "excerpt_only" });
    const { writer, calls } = fakeWriter([goodScript()]);
    const { deps } = depsFor(store, writer, fakeSynth());
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;
    expect(await dispatch(deps, "podcast", { episodeId: row.id })).toMatchObject({ status: "failed", error: expect.stringMatching(/in full/) });
    expect(calls).toHaveLength(0);
  });

  it("is picked up from the database by the local runner", async () => {
    const { itemId, store } = await seed();
    const { writer } = fakeWriter([goodScript()]);
    const { deps } = depsFor(store, writer, fakeSynth());
    const { episode: row } = (await requestEpisode(db, identity(itemId)))!;
    expect(await runQueuedEpisodes(deps)).toBe(1);
    const [done] = await db.select({ status: episode.status }).from(episode).where(eq(episode.id, row.id));
    expect(done!.status).toBe("ready");
    expect(await runQueuedEpisodes(deps)).toBe(0);
  });
});

describe("wav", () => {
  it("round-trips mono 16-bit PCM and rejects other layouts", () => {
    const pcm = { sampleRate: 24000, samples: Int16Array.from([0, 1, -1, 32767, -32768]) };
    expect(parseWav(encodeWav(pcm))).toEqual(pcm);
    const stereo = encodeWav(pcm);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => parseWav(stereo)).toThrow(/2 channels/);
    expect(() => parseWav(new Uint8Array(4))).toThrow(/Not a WAV/);
  });

  it("renders clips at their offsets with silence between, and measures it", () => {
    const loud = new Int16Array(100).fill(5000);
    const pcm = renderPlan([loud, loud], { offsets: [0, 300], totalSamples: 450, chapters: [] }, 1000);
    expect(pcm.samples.length).toBe(450);
    expect(pcm.samples[150]).toBe(0);
    expect(pcm.samples[350]).toBe(5000);
    expect(silenceStats(pcm)).toEqual({ longestSeconds: 0.2, silentFraction: 0.556 });
  });

  it("resamples linearly", () => {
    const out = resample({ sampleRate: 2, samples: Int16Array.from([0, 100, 200, 300]) }, 4);
    expect(Array.from(out.samples)).toEqual([0, 50, 100, 150, 200, 250, 300, 300]);
  });
});

describe("ffmetadata", () => {
  it("writes chapters in milliseconds, each ending where the next starts", () => {
    const text = ffmetadata({
      title: "A=B; #1",
      artist: "Ann",
      durationSeconds: 90.5,
      chapters: [
        { title: "Opening", startSeconds: 0 },
        { title: "Why", startSeconds: 30.25 },
      ],
    });
    expect(text).toBe(
      [";FFMETADATA1", "title=A\\=B\\; \\#1", "artist=Ann", "[CHAPTER]", "TIMEBASE=1/1000", "START=0", "END=30250", "title=Opening", "[CHAPTER]", "TIMEBASE=1/1000", "START=30250", "END=90500", "title=Why", ""].join("\n"),
    );
  });
});
