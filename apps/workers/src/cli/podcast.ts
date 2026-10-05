// Makes a podcast episode of one piece now, without the queue, and reports how it went.
//   pnpm --filter @fs/workers podcast <itemId|url> [--format conversation|narration] [--fresh]
// --fresh makes a new episode even if this piece already has one. Locally the episode, plus its
// script as JSON beside it, lands in PODCAST_DIR (apps/workers/.data/podcast by default).
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PODCAST_SCRIPT_PROMPT_VERSION } from "@fs/ai";
import { readEnv } from "@fs/config";
import { episodeVoiceKey } from "@fs/core";
import { requestEpisode, schema } from "@fs/db";
import { canonicalizeUrl } from "@fs/ingest";
import { eq, or } from "drizzle-orm";
import { buildPipelineDeps } from "../lib/build-deps.ts";
import { memoryQueues } from "../lib/queues.ts";
import { generateEpisode } from "../podcast/generate.ts";

const { contentItem, episode } = schema;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { format: { type: "string", default: "conversation" }, fresh: { type: "boolean", default: false } },
});
const target = positionals[0];
const format = values.format;
if (!target || (format !== "conversation" && format !== "narration")) {
  console.error("Usage: pnpm --filter @fs/workers podcast <itemId|url> [--format conversation|narration] [--fresh]");
  process.exit(1);
}

const env = readEnv();
const deps = await buildPipelineDeps(env, memoryQueues().queues);
const { db } = deps;
const podcast = deps.podcast;

try {
  if (!podcast) throw new Error("Podcasts are off (PODCAST_TTS=none)");
  const isId = /^[0-9a-f-]{36}$/i.test(target);
  const [item] = await db
    .select({ id: contentItem.id, title: contentItem.title })
    .from(contentItem)
    .where(isId ? eq(contentItem.id, target) : or(eq(contentItem.canonicalUrl, target), eq(contentItem.canonicalUrl, safeCanonical(target))));
  if (!item) throw new Error(`No item ${target}`);

  const identity = {
    itemId: item.id,
    format,
    promptVersion: podcast.scriptWriter?.promptVersion ?? PODCAST_SCRIPT_PROMPT_VERSION,
    voiceKey: episodeVoiceKey(podcast.synth.engine, format),
  };
  let requested = await requestEpisode(db, { ...identity, userId: null });
  if (requested && values.fresh && requested.episode.status !== "queued") {
    await db.delete(episode).where(eq(episode.id, requested.episode.id));
    requested = await requestEpisode(db, { ...identity, userId: null });
  }
  if (!requested) throw new Error("The item has no extracted version");
  console.log(`▶ ${item.title}\n  episode ${requested.episode.id} (${identity.voiceKey}, ${identity.promptVersion}, script by ${podcast.scriptWriter?.model ?? "none"}, encoder ${podcast.encoder.name})`);

  let row = requested.episode;
  let checks: Record<string, unknown> | undefined;
  let timings: Record<string, unknown> | undefined;
  if (row.status !== "ready") {
    const out = await generateEpisode({ ...deps, log: () => {} }, { episodeId: row.id });
    if (out.status !== "ready") throw new Error(`Episode ${out.status}: ${out.error}`);
    row = out.row!;
    checks = out.checks;
    timings = out.timings;
  } else console.log("  (already made; --fresh to make it again)");

  const path = row.audioKey && podcast.audio.pathOf?.(row.audioKey);
  if (path && row.script) await writeFile(path.replace(/\.\w+$/, ".script.json"), JSON.stringify({ episode: row.id, chapters: row.chapters, script: row.script }, null, 2));
  console.log(
    [
      `✓ ${path ?? row.audioKey}`,
      `  ${row.durationSeconds}s audio (${row.audioType}, ${row.sampleRate} Hz, ${Math.round((row.audioBytes ?? 0) / 1024)} KB), ${row.words} words`,
      `  script: ${row.scriptMethod} ${row.scriptModel ?? ""}${row.scriptProblems?.length ? ` (rejected: ${row.scriptProblems.join(", ")})` : ""}`,
      `  made in ${((row.generationMs ?? 0) / 1000).toFixed(1)}s, est. cost $${row.costUsd?.toFixed(4)} (${JSON.stringify(row.cost)})`,
      timings ? `  timings: ${JSON.stringify(timings)}` : "",
      checks ? `  checks: ${JSON.stringify(checks)}` : "",
      `  chapters: ${(row.chapters ?? []).map((c) => `${c.startSeconds}s ${c.title}`).join(" · ")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await deps.close();
}

function safeCanonical(url: string): string {
  try {
    return canonicalizeUrl(url);
  } catch {
    return url;
  }
}
