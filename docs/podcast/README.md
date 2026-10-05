# Podcast experiment: "Listen" to a piece

This turns an article into a short episode, 4–7 minutes long, in which two hosts talk it through.
- The script is written by Claude, grounded in the article only and checked deterministically.
- The voices come from **Kokoro-82M** on your Mac, for free.
- On AWS the voices would come from **Amazon Polly neural** instead.

Each episode is made once per article version and shared by every user, like section summaries.

Research and costs are in [RESEARCH.md](./RESEARCH.md).

## Run it locally

```sh
pnpm install
pnpm --filter @fs/workers podcast:setup     # once: uv venv in apps/workers/tts + Kokoro model (~355 MB, gitignored)
pnpm db:migrate                             # adds the `episode` table (migration 0014)

# One episode, now (by item ID or URL). Prints the file path, duration, timings, cost and checks:
pnpm --filter @fs/workers podcast <itemId|url> [--format conversation|narration] [--fresh]
```

**Needs:**
- `uv` ([install](https://docs.astral.sh/uv/)). It manages its own Python 3.12; nothing is installed system-wide.
- The Claude Code CLI (`claude`), which is already used for letters locally.
- **Encoder:** ffmpeg if you have it, which also writes the chapters into the file. Otherwise macOS's built-in `afconvert` (AAC .m4a, about 0.5 MB a minute). Otherwise WAV.

**In the app:**
- Run `pnpm dev:api` and `pnpm dev:workers` as usual.
- Open an article (from a letter or the library). On the piece page there's a **headphones** button next to *Read*, and at the top of the article a **Listen** card.
- Tap either one. The card shows *Making the episode* while it polls every 4 seconds, then turns into a player with play/pause, a scrubber with chapter ticks, the time, and the current chapter.
- The player uses `expo-audio` (SDK 57, included in Expo Go).
- The local API serves the files at `/podcast/audio/<key>`, with Range support for iOS.

**Env vars** (all optional; see `.env.example`):

| Var | Default | Meaning |
|---|---|---|
| `PODCAST_TTS` | `kokoro` locally, `polly` on AWS | `none` turns episodes off |
| `PODCAST_FORMAT` | `conversation` | or `narration` (one voice) |
| `PODCAST_DIR` | `.data/audio` | where local episodes go (relative to `apps/workers`) |
| `PODCAST_BUCKET` / `PODCAST_BASE_URL` | — | on AWS: the images bucket and its CloudFront URL |
| `QUEUE_URL_PODCAST` | — | on AWS: the `podcast` SQS queue |
| `UV_PATH`, `FFMPEG_PATH`, `KOKORO_THREADS` | `uv`, `ffmpeg`, half the cores (max 6) | local tools |

The script uses the existing `LETTER_WRITER` switch: `claude-cli` locally, `anthropic` on AWS. With `none`, episodes fall back to reading the piece's opening aloud.

## How it works

```
app "Listen" → POST /items/:id/episode → episode row (queued) → SQS `podcast` (AWS) / DB poll (dev runner)
  → worker generateEpisode:
      blocks (content store) → article text (headings, paragraphs, lists, quotes)
      → script (Claude, structured output: chapters → lines {host|cohost, text})
      → checks (@fs/core checkEpisodeScript); one retry told what failed; else the piece's own opening
      → each line → speakable() → splitForSpeech() → TTS clip per chunk (Kokoro or Polly)
      → stitchPlan(): pauses for chunks/turns/paragraphs/chapters + chapter marks
      → WAV → AAC .m4a (ffmpeg | afconvert | WAV) → audio store (dir | S3 podcast/…)
      → row: ready, duration, chapters, cost, provenance
app polls GET /items/:id/episode → audioUrl → expo-audio
```

**Where the code is:**
- **Pure logic:** `packages/core/src/podcast.ts`. Script types, checks, fallback, `speakable`, chunking, stitch plan, voices and cost estimates.
- **Script writer:** `packages/ai/src/podcast-script.ts`. Anthropic API and Claude Code CLI, the same prompt for both, `podcast-script-v1`.
- **Worker:** `apps/workers/src/podcast/*`:
  - `generate.ts` is the job.
  - `synth.ts` has Kokoro (a long-lived Python process) and Polly.
  - `wav.ts`, `encode.ts`, `audio-store.ts`.
  - `local.ts` is the dev-runner loop.
  - The CLI is `src/cli/podcast.ts` and the Lambda handler is `src/handlers/podcast.ts`.
- **TTS server:** `apps/workers/tts/kokoro_server.py` (JSON lines over stdin/stdout) and `pyproject.toml`/`uv.lock`.
- **API:** `apps/api/src/routes/podcast.ts` and `apps/api/src/lib/podcast.ts` (the queue, the view, and local audio serving).
- **App:** `apps/mobile/src/lib/podcast.ts` and `apps/mobile/src/components/letter/Listen.tsx`, wired into `Reader.tsx` and `PiecePage.tsx`.
- **DB:** `packages/db/src/schema/podcast.ts` and `queries/episodes.ts`; migration `0014_podcast.sql`.

**The `episode` table:**
- **Unique key:** `(item_version_id, format, prompt_version, voice_key)`. A changed article, prompt or voice makes a new episode; an old one is never overwritten.
- **Status:** `queued → scripting → voicing → ready | failed`. There is a 20-minute lease for a crashed worker, and asking again requeues a failed episode.
- **Provenance:** script method and model, rejected-script reasons, TTS engine and model, audio key, type, size, duration, sample rate, word count, `cost_usd` with a breakdown, and `generation_ms`.

**Grounding** (in the spirit of the letter's §6.5 checks):
- Every number in the script must appear in the article or its title.
- Numbers above ten must be written as digits so the check can see them.
- Every quote must appear in the article.
- No links, speaker labels or stage directions are allowed.
- The format must have the right speakers, and the length is bounded (300–1,500 words).

If a script fails, Claude gets one retry that is told what failed. If that also fails, the episode reads the piece's opening verbatim (`format: reading`), so nothing invented is ever voiced. Only articles the app may show in full (`full_text` + `retainText`) get episodes.

## On AWS (written, validated, not applied)

Set `podcast_enabled = true` in the env's `module "stack"` block (`infra/modules/stack`). The default is `false`. It adds:
- **Queue:** a `podcast` SQS queue with a DLQ.
- **Worker:** a `podcast` Lambda with a 900 s timeout, 1 GB of memory and concurrency 2. It can read secrets, `GetObject` on content, `PutObject` on `podcast/*` in the **images bucket**, and `polly:SynthesizeSpeech`. It reaches Polly through the existing NAT.
- **CDN:** CloudFront reads `podcast/*` from the images bucket as well as `images/*`. Episodes reuse the images distribution, so there is no new bucket or distribution.
- **API:** the API gets `sqs:SendMessage` on the queue, plus the `PODCAST_*` and `QUEUE_URL_PODCAST` env vars.

Everything stays in ap-southeast-2. CloudFront is global, as it already is for images.

**Cost** (see RESEARCH.md): about **$0.02–0.04 for the script plus $0.06–0.14 for Polly neural per episode**, made once. Polly's free tier covers about 280 episodes a month for 12 months. Lambda time is negligible: about 2 minutes at 1 GB, under $0.002.

## Sample episodes (generated on this machine, gitignored)

Both used Kokoro (`af_heart` + `am_michael`), a script by `claude-cli:sonnet`, and `afconvert` (AAC, 64 kbps, 24 kHz mono). They are under `apps/workers/.data/audio/podcast/items/`. Each `.m4a` has a `.script.json` beside it.

| Piece | Audio | Words | Chapters | Made in | Est. cost (API-equivalent) |
|---|---|---|---|---|---|
| *10 Years of Experiments Running a Subscription Business* (Patrick Rauland) | 239.7 s, 1.9 MB | 621 | 5 | 1,868 s (incl. one 4-min CLI timeout; phase timings weren't recorded yet) | $0.021 |
| *An Ode to Counter-Positioning* (Packy McCormick) | 220.7 s, 1.8 MB | 574 | 5 | 1,047 s (script 15 s, voice 1,032 s, encode 0.2 s) | $0.021 |

**Objective checks:**
- **Duration vs. script length:** 239.7 s against 226 s expected at 165 words a minute, and 220.7 s against 209 s.
- **Silence:** the longest silence is 1.05 s in both. That is the designed chapter gap (0.9 s) plus the natural pause at the end of a clip; there are no dead-air gaps. About 22% of 10 ms windows are quiet, which is the designed pauses between sentences and turns.
- **Format:** both are 24,000 Hz mono AAC at about 64.6 kbps (checked with `afinfo`). Durations match the DB to 0.01 s.

**Voicing speed:**
- On an idle machine, Kokoro voiced sample 1's script (229 s of audio) in **26 s**, about 8.7× real-time.
- Both recorded runs happened while the Mac was very busy (load average 5–7 from other projects' dev servers and Spotlight), so voicing crawled at about 0.2× real-time.
- The first run also lost a CLI script attempt to a timeout. That timeout is now 7 minutes, and the retry succeeded.

## What's left

- **Listen and judge** the two samples (and a `--format narration` one) before investing more; nobody has heard them yet.
- **Speed locally:**
  - Try mlx-audio's Kokoro on Metal (12–22× real-time reported; check the NaN bug first).
  - Try the int8/fp16 ONNX models.
  - Voice the chunks of a line in parallel with two Kokoro processes.
- **AWS encoder:**
  - A zip Lambda has no ffmpeg/afconvert, so episodes would be stored as **WAV** (about 1.9 MB a minute at 16 kHz).
  - Fix this with a static-ffmpeg Lambda layer (`FFMPEG_PATH=/opt/bin/ffmpeg`) or a pure-JS MP3 encoder.
  - Or move the worker to a container image, which would also allow Kokoro on Lambda.
- **App polish:**
  - Lock-screen and background playback (`setActiveForLockScreen`, `shouldPlayInBackground` and the iOS background-audio config; this needs a dev build, not Expo Go).
  - A mini player that persists across pieces, playback speed, and chapter skip buttons.
  - The pill's tray could offer "Listen" while reading.
  - No on-device check yet: everything is typechecked and linted, but the player hasn't been tried in Expo Go.
- **Product:**
  - Personalise the intro with the reader's brief (per user, not stored, like "for you").
  - A daily "letter as a podcast" that stitches the day's picks.
- **Ops:** an episode-specific CloudWatch alarm on failures (the DLQ alarm exists), and cleaning up superseded episodes' files.
- **Rights:** episodes are derivative audio of full texts, which is fine for personal use, the same rule as reading in the app. Revisit before any wider release.
