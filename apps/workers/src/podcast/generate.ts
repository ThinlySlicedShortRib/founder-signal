import type { EpisodeScriptWriter, ScriptInput } from "@fs/ai";
import {
  checkEpisodeScript,
  type ClipInfo,
  type EpisodeScript,
  episodeParagraphs,
  episodeSourceText,
  episodeVoiceKey,
  estimateEpisodeCost,
  readingScript,
  scriptWords,
  speakable,
  splitForSpeech,
  stitchPlan,
} from "@fs/core";
import { type EpisodeRow, schema } from "@fs/db";
import type { Block, Rights } from "@fs/schema";
import { eq, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import { type AudioStore, episodeAudioKey } from "./audio-store.ts";
import type { AudioEncoder } from "./encode.ts";
import type { SpeechSynth } from "./synth.ts";
import { encodeWav, renderPlan, resample, silenceStats } from "./wav.ts";

const { contentItem, contentVersion, episode, publisher } = schema;

/** The podcast experiment's parts, injected like the rest of the pipeline. */
export interface Podcast {
  /** Writes the script; null reads the piece's own opening instead (no model). */
  scriptWriter: EpisodeScriptWriter | null;
  synth: SpeechSynth;
  audio: AudioStore;
  encoder: AudioEncoder;
}

/** A worker that died mid-episode leaves it claimed; another may take it over after this. */
const LEASE_MINUTES = 20;
/** The model gets this many tries to pass the checks before the piece's own words are read instead. */
const SCRIPT_ATTEMPTS = 2;

export interface EpisodeOutcome {
  episodeId: string;
  status: "ready" | "failed" | "skipped";
  error?: string;
  row?: EpisodeRow;
  /** Objective checks on the finished audio (nobody listens before it's shared). */
  checks?: { longestSilenceSeconds: number; silentFraction: number; expectedSeconds: number };
  /** Where the time went. */
  timings?: { scriptMs: number; voiceMs: number; encodeMs: number };
}

/**
 * Makes one episode (the `podcast` queue): claims it, writes and checks the
 * script, voices it chunk by chunk, stitches and encodes it, stores the file
 * and records what it cost. A failure marks it `failed` rather than throwing,
 * so a broken piece isn't retried forever; asking again requeues it.
 */
export async function generateEpisode(deps: PipelineDeps, { episodeId }: { episodeId: string }): Promise<EpisodeOutcome> {
  const log = logger(deps);
  const podcast = deps.podcast;
  if (!podcast) {
    log("episode_skipped", { episodeId, reason: "podcast_off" });
    return { episodeId, status: "skipped", error: "podcast_off" };
  }
  const { db } = deps;
  const started = Date.now();

  const [row] = await db
    .update(episode)
    .set({ status: "scripting", startedAt: sql`now()`, attempts: sql`${episode.attempts} + 1`, error: null })
    .where(
      sql`${episode.id} = ${episodeId} and (${episode.status} = 'queued'
        or (${episode.status} in ('scripting', 'voicing') and ${episode.startedAt} < now() - make_interval(mins => ${LEASE_MINUTES})))`,
    )
    .returning();
  if (!row) {
    log("episode_skipped", { episodeId, reason: "not_queued" });
    return { episodeId, status: "skipped", error: "not_queued" };
  }

  try {
    const format = row.format as ScriptInput["format"];
    if (episodeVoiceKey(podcast.synth.engine, format) !== row.voiceKey) throw new Error(`This worker voices ${podcast.synth.engine}, not ${row.voiceKey}`);

    const [piece] = await db
      .select({
        title: contentItem.title,
        url: contentItem.canonicalUrl,
        author: contentItem.authorName,
        type: contentItem.type,
        sourceName: publisher.name,
        blocksKey: contentVersion.blocksKey,
        rights: contentVersion.rightsSnapshot,
      })
      .from(contentVersion)
      .innerJoin(contentItem, eq(contentItem.id, contentVersion.itemId))
      .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
      .where(eq(contentVersion.id, row.itemVersionId));
    if (!piece) throw new Error("The piece's version is gone");
    const rights = piece.rights as Rights;
    // An episode retells the full text, so it needs the same rights as reading it in the app.
    if (piece.type !== "article" || rights.display !== "full_text" || !rights.retainText || !piece.blocksKey) throw new Error("Only articles we can show in full get episodes");
    const stored = await deps.store.getJson<{ blocks: Block[] }>(piece.blocksKey);
    const paragraphs = episodeParagraphs(stored?.blocks ?? []);
    if (!paragraphs.length) throw new Error("The piece has no text");

    const title = piece.title ?? piece.url;
    const scriptStarted = Date.now();
    const source = episodeSourceText(paragraphs);
    const script = await writeScript(podcast.scriptWriter, {
      format,
      title,
      sourceName: piece.sourceName,
      author: piece.author,
      text: source.text,
      truncated: source.truncated,
    }, paragraphs, (event, data) => log(event, { episodeId, ...data }));

    await db.update(episode).set({ status: "voicing", script: script.script, scriptMethod: script.method, scriptModel: script.model, scriptProblems: script.problems }).where(eq(episode.id, row.id));

    const voiceStarted = Date.now();
    // Voice every chunk of every line, in order.
    const synth = podcast.synth;
    const clips: Int16Array[] = [];
    const info: ClipInfo[] = [];
    let sampleRate = 0;
    let characters = 0;
    for (const [c, chapter] of script.script.chapters.entries()) {
      for (const [l, line] of chapter.lines.entries()) {
        for (const chunk of splitForSpeech(speakable(line.text))) {
          const pcm = await synth.synthesize(chunk, line.speaker);
          sampleRate ||= pcm.sampleRate;
          const samples = resample(pcm, sampleRate).samples;
          clips.push(samples);
          info.push({ chapter: c, line: l, speaker: line.speaker, samples: samples.length });
          characters += chunk.length;
        }
      }
    }
    if (!clips.length) throw new Error("Nothing to voice");

    const encodeStarted = Date.now();
    const plan = stitchPlan(info, script.script.chapters.map((ch) => ch.title), sampleRate);
    const pcm = renderPlan(clips, plan, sampleRate);
    const durationSeconds = Math.round((pcm.samples.length / sampleRate) * 100) / 100;
    const encoded = await podcast.encoder.encode(encodeWav(pcm), {
      title,
      artist: [piece.author, piece.sourceName].filter(Boolean).join(", "),
      chapters: plan.chapters,
      durationSeconds,
    });
    const audioKey = episodeAudioKey(row.itemId, row.id, encoded.ext);
    await podcast.audio.put(audioKey, encoded.bytes, encoded.contentType);

    const timings = { scriptMs: voiceStarted - scriptStarted, voiceMs: encodeStarted - voiceStarted, encodeMs: Date.now() - encodeStarted };
    const words = scriptWords(script.script);
    const cost = estimateEpisodeCost({
      model: script.model,
      inputTokens: script.usage?.inputTokens,
      outputTokens: script.usage?.outputTokens,
      promptChars: script.promptChars,
      outputChars: script.outputChars,
      ttsPriceKey: synth.priceKey,
      characters,
    });
    const [done] = await db
      .update(episode)
      .set({
        status: "ready",
        chapters: plan.chapters,
        ttsEngine: synth.engine,
        ttsModel: synth.model,
        audioKey,
        audioType: encoded.contentType,
        audioBytes: encoded.bytes.byteLength,
        durationSeconds,
        sampleRate,
        words,
        costUsd: cost.totalUsd,
        cost,
        generationMs: Date.now() - started,
        finishedAt: sql`now()`,
      })
      .where(eq(episode.id, row.id))
      .returning();
    const silence = silenceStats(pcm);
    const checks = { longestSilenceSeconds: silence.longestSeconds, silentFraction: silence.silentFraction, expectedSeconds: Math.round((words / 165) * 60) };
    log("episode_ready", { episodeId, durationSeconds, words, costUsd: cost.totalUsd, ms: Date.now() - started, method: script.method, ...checks, ...timings });
    return { episodeId, status: "ready", row: done, checks, timings };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    await db.update(episode).set({ status: "failed", error: message, finishedAt: sql`now()` }).where(eq(episode.id, row.id));
    log("episode_failed", { episodeId, error: message });
    return { episodeId, status: "failed", error: message };
  }
}

interface WrittenScript {
  script: EpisodeScript;
  method: string;
  model: string | null;
  problems: string[] | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  promptChars: number;
  outputChars: number;
}

/**
 * The model's script if it passes the checks (a second try is told what
 * failed); otherwise the piece's own opening, read aloud.
 */
async function writeScript(
  writer: EpisodeScriptWriter | null,
  input: ScriptInput,
  paragraphs: string[],
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<WrittenScript> {
  const problems: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let known = true;
  let promptChars = 0;
  let outputChars = 0;
  if (writer) {
    let last: string[] = [];
    for (let attempt = 1; attempt <= SCRIPT_ATTEMPTS; attempt++) {
      try {
        const out = await writer.write(attempt > 1 && last.length ? { ...input, problems: last } : input);
        promptChars += out.promptChars;
        outputChars += out.outputChars;
        if (out.usage) {
          usage.inputTokens += out.usage.inputTokens;
          usage.outputTokens += out.usage.outputTokens;
        } else known = false;
        last = checkEpisodeScript(out.script, { title: input.title, text: input.text });
        if (!last.length) {
          return { script: out.script, method: writer.method, model: writer.model, problems: problems.length ? problems : null, usage: known ? usage : null, promptChars, outputChars };
        }
        log("episode_script_rejected", { attempt, reasons: last });
        problems.push(...last.map((r) => `${attempt}:${r}`));
      } catch (err) {
        log("episode_script_error", { attempt, error: (err as Error).message });
        problems.push(`${attempt}:error:${(err as Error).message.slice(0, 120)}`);
        last = [];
      }
    }
  }
  return {
    script: readingScript({ title: input.title, sourceName: input.sourceName, author: input.author }, paragraphs),
    method: "fallback",
    // The rejected attempts still cost something.
    model: writer && promptChars ? writer.model : null,
    problems: problems.length ? problems : null,
    usage: writer && known && promptChars ? usage : null,
    promptChars,
    outputChars,
  };
}
