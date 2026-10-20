import type { ChapterMark, EpisodeCost, EpisodeScript } from "@fs/core";
import { index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { contentItem, contentVersion } from "./ingestion.ts";

/**
 * The podcast experiment: a piece as a short audio episode. Like section
 * summaries, an episode is made once and shared by every user: it's keyed by
 * the piece's version, the format, the script prompt version and the voice,
 * so a changed article, prompt or voice makes a new one and an old one is
 * never overwritten.
 *
 * Status: `queued` (asked for, waiting for a worker) → `scripting` →
 * `voicing` → `ready`, or `failed` (asking again requeues it).
 */
export const episodeStatus = pgEnum("episode_status", ["queued", "scripting", "voicing", "ready", "failed"]);

export const episode = pgTable(
  "episode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => contentItem.id, { onDelete: "cascade" }),
    itemVersionId: uuid("item_version_id")
      .notNull()
      .references(() => contentVersion.id, { onDelete: "cascade" }),
    /** What was asked for: `conversation` (two hosts) or `narration` (one voice). See @fs/core `episodeFormats`. */
    format: text("format").notNull(),
    /** The script prompt version asked for (e.g. `podcast-script-v1`). */
    promptVersion: text("prompt_version").notNull(),
    /** The engine, model and voices, e.g. `kokoro-v1.0:af_heart+am_michael` or `polly-neural:Olivia+Matthew`. */
    voiceKey: text("voice_key").notNull(),
    status: episodeStatus("status").default("queued").notNull(),
    /**
     * How far along it is, 0 → 1, for the app's progress ring: the script is 0 → 0.25, voicing 0.25 → 0.95
     * (per chunk voiced), encoding and storing 0.95 → 1. Written by the worker as it goes.
     */
    progress: real("progress").default(0).notNull(),

    /** The script that was voiced. Its `format` is `reading` when the model's script kept failing its checks. */
    script: jsonb("script").$type<EpisodeScript>(),
    /** Where each chapter starts in the audio. */
    chapters: jsonb("chapters").$type<ChapterMark[]>(),
    /** How the script was written: `anthropic`, `claude-cli` or `fallback` (the piece's own words). */
    scriptMethod: text("script_method"),
    scriptModel: text("script_model"),
    /** Why the model's scripts were rejected, when the fallback was used or a retry was needed. */
    scriptProblems: text("script_problems").array(),
    /** `kokoro` (local, open weights) or `polly`. */
    ttsEngine: text("tts_engine"),
    ttsModel: text("tts_model"),

    /** Object key in the audio store (a local directory, or the images bucket on AWS). */
    audioKey: text("audio_key"),
    /** `audio/mp4` (AAC in .m4a), `audio/mpeg` or `audio/wav` when no encoder was available. */
    audioType: text("audio_type"),
    audioBytes: integer("audio_bytes"),
    durationSeconds: real("duration_seconds"),
    sampleRate: integer("sample_rate"),
    /** Spoken words in the script. */
    words: integer("words"),
    /** Estimated cost in USD (a CLI script is priced as the API model it stands in for), with its parts. */
    costUsd: real("cost_usd"),
    cost: jsonb("cost").$type<EpisodeCost>(),
    /** Wall-clock time to make it, script and voice. */
    generationMs: integer("generation_ms"),

    /** The user who first asked for it (episodes are shared; this is only for the experiment's numbers). */
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    attempts: integer("attempts").default(0).notNull(),
    error: text("error"),
    /** Lease: another worker doesn't pick it up while this is recent. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("episode_version_format_prompt_voice").on(t.itemVersionId, t.format, t.promptVersion, t.voiceKey),
    index("episode_item_idx").on(t.itemId),
    index("episode_status_idx").on(t.status),
  ],
);
