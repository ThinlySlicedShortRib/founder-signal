# Founder Signal

A personal reading app: it follows the sources you choose, finds new ones on
the open web, and sends a short letter of the pieces most worth your time.
See [`docs/Founder_Signal_Build_Plan.md`](docs/Founder_Signal_Build_Plan.md)
for the architecture and milestones, and [`infra/README.md`](infra/README.md)
for AWS.

## Layout

| Path | What |
|---|---|
| `apps/api` | Hono API on Lambda (Better Auth, `/me/sources`, `/client-logs`) |
| `apps/workers` | Lambda workers: `migrate`, and the ingestion pipeline `sweep → fetch-source → extract → enrich` |
| `apps/mobile` | Expo app (Expo Router): email-code sign-in, Today · Library · Activity · Preferences tabs, source management, JS error reporting |
| `packages/core` | Pure domain rules (rights, fetch scheduling, reading time); no I/O |
| `packages/ingest` | Source adapters, SSRF-safe fetching, extraction to blocks, transcripts |
| `packages/ai` | Claude enrichment (Message Batches) and Bedrock embeddings |
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
and embeddings).

The app finds the API on the machine running the Expo dev server (port 8787),
so a phone on the same network works without configuration. Release builds set
`EXPO_PUBLIC_API_URL`.

After changing `packages/db/src/schema`, run `pnpm db:generate` and commit
the migration; CI fails if they're out of sync.
