# Founder Signal

A personal reading app: it follows the sources you choose, finds new ones on
the open web, and sends a short letter of the pieces most worth your time.
See [`docs/Founder_Signal_Build_Plan.md`](docs/Founder_Signal_Build_Plan.md)
for the architecture and milestones, and [`infra/README.md`](infra/README.md)
for AWS.

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono API on Lambda (Better Auth, `/me/sources`, `/me/preferences`, `/me/schedule`, `/me/onboarding`, `/items/:id/review`, `/client-logs`) |
| `apps/workers` | Lambda workers: `migrate`, and the ingestion pipeline `sweep → fetch-source → extract → enrich` |
| `apps/mobile` | Expo app (Expo Router): email-code sign-in, onboarding (import from your AI, fill-in sentence, five quick picks), Today · Library · Activity · Preferences tabs, source management, JS error reporting |
| `packages/core` | Pure domain rules (rights, fetch scheduling, delivery schedule, onboarding import parsing, reading time); no I/O |
| `packages/ingest` | Source adapters, SSRF-safe fetching, extraction to blocks, transcripts |
| `packages/ai` | Claude enrichment (Message Batches), onboarding profile import, and Bedrock embeddings |
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
pnpm dev:workers                # ingestion pipeline, sweeping every minute
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

The app finds the API on the machine running the Expo dev server (port 8787),
so a phone on the same network works without configuration. Release builds set
`EXPO_PUBLIC_API_URL`.

After changing `packages/db/src/schema`, run `pnpm db:generate` and commit
the migration; CI fails if they're out of sync.
