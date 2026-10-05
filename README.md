# Founder Signal

A personal reading app: it follows the sources you choose, finds new ones on
the open web, and sends a short letter of the pieces most worth your time.
See [`docs/Founder_Signal_Build_Plan.md`](docs/Founder_Signal_Build_Plan.md)
for the architecture and milestones, and [`infra/README.md`](infra/README.md)
for AWS.

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono API on Lambda (Better Auth, `/me/sources`, `/me/preferences`, `/me/schedule` incl. `test-letter`, `/me/onboarding`, `/letters`, `/items/:id` + `/summary` + `/review`, `/events`, `/me/saved`, `/me/activity`, `/me/authors/:key/follow`, `/client-logs`) |
| `apps/workers` | Lambda workers: `migrate`, the ingestion pipeline `sweep → fetch-source → extract → enrich`, and the letter engine `sweep → letter-step` (collect → rank → generate → verify → lock → ready → sent) plus `author` cards |
| `apps/mobile` | Expo app (Expo Router): email-code sign-in, onboarding (import from your AI, fill-in sentence, five quick picks), Layout 6 (`docs/design/layout6`): Today as full-screen pages with pull-to-read, every action in a floating pill, a big-type menu instead of tabs; Library, Activity, Preferences, source management, JS error reporting |
| `packages/core` | Pure domain rules (rights, fetch scheduling, delivery schedule, onboarding import parsing, reading time, ranking, feedback codes, copy verification, activity, P.S.); no I/O |
| `packages/ingest` | Source adapters, SSRF-safe fetching, extraction to blocks, transcripts |
| `packages/ai` | Claude enrichment (Message Batches), onboarding profile import, the letter writer, section summaries and recaps, author cards (web search), and Bedrock embeddings |
| `packages/db` | Drizzle schema, migrations and shared queries |
| `packages/schema` | zod contracts shared with the app |
| `packages/config` | Environment and secrets |

## Local development

Needs Node 22 (`.nvmrc`), pnpm (`corepack enable`) and Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up && pnpm db:migrate   # Postgres 17 + pgvector on localhost:5433
pnpm typecheck && pnpm test     # tests use their own databases on the same server

pnpm dev:api                    # API on :8787; sign-in codes print to the console
pnpm dev:workers                # ingestion every minute; letters (schedules, test letters) every 5s
pnpm dev:mobile                 # Expo dev server: scan the QR code with Expo Go, or press w for web

# Add sources for a user and run ingestion to completion, then list the items:
pnpm ingest you@example.com jvns.ca https://seths.blog/
```

Optional keys in `.env`: `YOUTUBE_API_KEY` (YouTube channels and videos),
`SUPADATA_API_KEY` (video transcripts), and `ENRICHMENT=anthropic` with
`ANTHROPIC_API_KEY` plus AWS credentials for Bedrock (tags, quality labels
and embeddings). Onboarding's "import from your AI" reads the pasted note
through the Claude Code CLI on your machine (`claude`, signed in), so it needs
no key locally; set `PROFILE_IMPORTER=anthropic` to use `ANTHROPIC_API_KEY`
instead. If neither works, a plain parser reads the note.

Letters are written by Claude too. Locally the letter copy (Sonnet), section
summaries and the P.S. recap (Haiku) and author cards (Sonnet with web search)
all go through the same Claude Code CLI (`LETTER_WRITER=claude-cli`, the
default); `LETTER_WRITER=anthropic` uses `ANTHROPIC_API_KEY`, and
`LETTER_WRITER=none` writes copy from each piece's own opening sentences with
no model (also the fallback whenever a call fails; nothing is ever invented).
`UNSPLASH_ACCESS_KEY` adds stock photos for pieces without their own image.
The first letter (made when onboarding is finished) and a test letter
(`POST /me/schedule/test-letter`) need `pnpm dev:workers` running: the API
can't reach its in-memory queues, so the runner picks them up through the
database within seconds. A new user follows nothing, so their first letter
searches the web first (`DISCOVERY`, a few minutes with the CLI); with
`DISCOVERY=none` it starts at once and only uses followed sources.

Every letter aims for at least three pieces. When the usual candidates run
short, collection widens the window to 180 days, then uses a shared pool of
good pages found for other users that match your topics, then (once per
letter) holds the letter for a discovery run of its own. Only then does it go
out short, and `letter.short_reason` says why. Dev tools (`GET /dev/state`)
shows each letter's `collection` steps and `shortReason`
(build plan §6.2, "Every letter has at least three pieces").

The app finds the API on the machine running the Expo dev server (port 8787),
so a phone on the same network works without configuration. Release builds set
`EXPO_PUBLIC_API_URL`.

After changing `packages/db/src/schema`, run `pnpm db:generate` and commit
the migration; CI fails if they're out of sync.
