# Founder Signal — Build plan

**Status:** Draft · 30 September 2026
**Companion to:** `Founder_Signal_React_Native_App_Spec.md` (section references below, written §n, point to that spec)
**Scope:** First release as defined in spec §14. No web app; only a minimal web fallback page for email links.
**Purpose:** Personal use, but deliberately built production-grade (one dev project for now with prod split out later, prod-style networking and database, TestFlight/App Store flows) as a hands-on way to learn Expo and AWS. Personal use only relaxes content licensing (§6.3) and keeps transcript costs within a free tier.

---

## 1. Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Mobile | **Expo** (Expo Router, TypeScript), EAS Build/Submit/Update | Push, deep links, OTA updates and managed iOS builds without native plumbing |
| Mobile data | TanStack Query + **expo-sqlite** (Drizzle) | Server cache plus durable offline store and outbox (§4, §14.4) |
| API | **Hono** on a single **Lambda** behind **API Gateway HTTP API** | Web-standard, first-party Lambda adapter, small cold starts, one-line Better Auth mount, typed client for Expo |
| Auth | **Better Auth** (+ `@better-auth/expo`) | Runs inside the API, stores users/sessions in our Postgres |
| Database | **RDS PostgreSQL** + **pgvector**, **RDS Proxy** | Relational integrity for idempotency; embeddings in the same DB |
| ORM / migrations | **Drizzle** | Shared schema package between API, workers and (separately) mobile SQLite |
| Async work | **SQS → Lambda** (Cloud Tasks equivalent) | Retries, DLQs, per-queue concurrency limits |
| Cron | **EventBridge Scheduler → Lambda** (Cloud Scheduler equivalent) | A 5-minute sweep drives letters and source fetches |
| Pipeline orchestration | **Postgres status machine + chained SQS messages** (no Step Functions) | Each step is idempotent via compare-and-set on the letter row |
| Storage / CDN | **S3** + **CloudFront** | Permitted full text/media; universal-link files; fallback page |
| AI | **Anthropic API directly** (`@anthropic-ai/sdk`), tiered by task: **`claude-sonnet-5-5`** ($2 / $10 per MTok) for letter copy, section summaries, claim verification and web-search discovery; **`claude-haiku-4-5`** ($1 / $5) for enrichment (tags, depth, quality), feedback-reason parsing and discovery query generation. **Message Batches** (50% off) for enrichment. **Embeddings** stay on AWS: Cohere Embed or Titan via Bedrock (Anthropic has no embeddings model). | Structured outputs, web search, batches, prompt caching. API key in Secrets Manager. API inputs aren't used for training by default. |
| Email | **SES** (+ React Email) | Letter email; bounce/complaint handling |
| Push | **SNS mobile push** → APNs (token auth) and FCM v1 | Native device tokens from `expo-notifications` |
| Transcripts | **Supadata** behind a `TranscriptProvider` interface; TranscriptAPI.com or an Apify actor as the backup | Its free tier (100 transcripts/month) covers personal use; paid plans start at $5/month. See §6.3. |
| Infra as code | **Terraform** (S3 backend, native lockfile) | Team already uses it |
| Observability | CloudWatch, X-Ray, Lambda Powertools. **Mobile errors also go to CloudWatch**, through our own `/client-logs` endpoint (§8) | Everything in one place; no third-party crash reporter |
| Monorepo | pnpm + Turborepo, esbuild for Lambda bundles | |

---

## 2. Architecture

```
                         ┌──────────────────────── AWS account (per env) ─────────────────────────┐
 Expo app ──HTTPS──▶ API Gateway (HTTP API) ──▶ λ api (Hono + Better Auth) ──▶ RDS Proxy ──▶ RDS Postgres
    ▲   ▲                                            │                                        (pgvector)
    │   │                                            ├──▶ SQS: summarize (on-demand section summaries)
    │   │                                            └──▶ S3 (permitted blocks, media)
    │   │
    │   │  EventBridge Scheduler (every 5 min) ──▶ λ sweep ──┬──▶ SQS: fetch-source ──▶ λ fetch ──▶ SQS: extract ──▶ λ extract ──▶ SQS: enrich ──▶ λ enrich
    │   │                                                     ├──▶ SQS: discover     ──▶ λ discover (Claude web search → candidate URLs → SQS: extract)
    │   │                                                     ├──▶ SQS: letter-step  ──▶ λ letter (collect → rank → generate → verify → lock)
    │   │                                                     └──▶ SQS: deliver      ──▶ λ deliver ──┬──▶ SES ──▶ email
    │   └──────────── SNS mobile push ◀──────────────────────────────────────────────────────────────┘
    │
    └── universal link ── CloudFront (links domain) ──┬── S3: apple-app-site-association, assetlinks.json
                                                      └── λ api: /i/:itemId web fallback page

 Claude calls: λ letter / λ enrich / λ discover / λ api(summary) ──▶ NAT ──▶ api.anthropic.com
 Embeddings:   λ enrich / λ letter ──▶ Bedrock (Cohere Embed / Titan)
 Every queue has a DLQ; DLQ depth alarms → CloudWatch → SNS → on-call email/Slack
```

**Networking:** Lambdas that touch the DB run in private subnets. They reach the internet (the Anthropic API, Bedrock embeddings, SES, SNS, the transcript API, Better Auth OAuth providers) through a NAT: **fck-nat** (an open-source NAT instance on a `t4g.nano` in an auto-scaling group of one, ~$7/mo including its public IPv4) in dev, and the **managed NAT gateway** (~$37/mo including its public IPv4, + $0.045/GB) in prod, with a second one if you want AZ redundancy. There's also an S3 gateway endpoint (free). Fetch/extract Lambdas don't need the DB directly: they write results to S3 and enqueue. They can therefore run **outside the VPC**, which keeps high-volume fetch traffic off the NAT.

---

## 3. Repository layout

```
founder-signal/
├─ apps/
│  ├─ mobile/               Expo app (Expo Router)
│  ├─ api/                  Hono app: routes, auth, web fallback page; exports AppType
│  └─ workers/              Lambda handlers: sweep, fetch, extract, enrich, discover, letter, deliver, summarize, ses-events
├─ packages/
│  ├─ schema/               zod schemas + TS types shared by api, workers, mobile
│  ├─ db/                   Drizzle schema, migrations, query helpers (Postgres)
│  ├─ core/                 Pure domain logic: scheduling, ranking, rights rules, feedback codes, activity rules
│  ├─ ingest/               Source adapters (RSS, URL, YouTube channel, web-search discovery, feed autodetection), canonicalization, extraction → blocks
│  ├─ ai/                   Anthropic client, Bedrock embeddings client, prompts (versioned), evidence retrieval, verification
│  ├─ email/                React Email templates
│  └─ config/               tsconfig, eslint, shared env parsing
├─ infra/
│  ├─ modules/              network, database, api, queues, workers, scheduler, storage-cdn, email, push, observability
│  └─ envs/{dev,prod}/      root modules, backend config, tfvars
└─ .github/workflows/       CI: typecheck, test, build bundles, terraform plan/apply, migrations, EAS
```

`packages/core` has **no I/O**, so the scheduling, ranking and rights rules can be unit-tested exhaustively.

---

## 4. Infrastructure (Terraform)

- **Accounts:** one AWS project, `dev` (the equivalent of a GCP project), on the new AWS experience. `prod` gets its own project later; `infra/envs/prod` is kept and validated but not applied. Locally the CLI uses the `founder-signal-dev` profile.
- **State:** S3 backend per account with `use_lockfile = true` (Terraform ≥ 1.10), so no DynamoDB lock table is needed.
- **Region: `ap-southeast-2` (Sydney).** It has SES, SNS mobile push and the Bedrock embedding models (Titan Text Embeddings v2 and Cohere Embed v4, checked on 4 October 2026). The new AWS experience is single-region, so everything regional lives here; only global services such as CloudFront may use `us-east-1`. Claude is called through Anthropic's API, which doesn't depend on the AWS region.
- **Lambda code deploys:** CI bundles each handler with esbuild and uploads the zips to an artifacts bucket keyed by git SHA. Terraform points `aws_lambda_function.s3_key` at that SHA. Infra and code are deployed in the same pipeline, and a rollback means applying the previous SHA.
- **Migrations:** Drizzle migrations run from a one-off `migrate` Lambda invoked by CI before the new API version goes live. Migrations must be backwards-compatible (expand, then contract).

| Module | Resources |
|---|---|
| `network` | VPC, 2 private + 2 public subnets, NAT, S3 gateway endpoint, security groups |
| `database` | RDS Postgres (gp3, encrypted with KMS, automated backups, PITR), parameter group with `pgvector`, RDS Proxy, Secrets Manager credentials |
| `api` | HTTP API, catch-all route → `api` Lambda, custom domain + ACM cert, access logs, throttling |
| `queues` | SQS queues + DLQs: `fetch-source`, `extract`, `enrich`, `discover`, `letter-step`, `deliver`, `summarize`; redrive policies |
| `workers` | One Lambda per handler, event-source mappings with `maximum_concurrency`, IAM roles scoped per function |
| `scheduler` | EventBridge Scheduler `rate(5 minutes)` → `sweep` |
| `storage-cdn` | Content bucket (private, KMS), artifacts bucket, links domain on CloudFront, S3 origin for AASA/assetlinks, API origin for `/i/*` |
| `email` | SES domain identity (DKIM, SPF, DMARC), configuration set → SNS → `ses-events` Lambda (bounce/complaint suppression) |
| `push` | SNS platform applications for APNs (token-based `.p8`) and FCM (v1 service account) |
| `observability` | Log groups with retention, alarms (see §9), dashboard, budget alerts |

---

## 5. Data model (Postgres)

Derived from spec §11. Only the constraints that carry correctness guarantees are listed.

| Table | Key columns / constraints | Notes |
|---|---|---|
| `user`, `session`, `account`, `verification` | Better Auth managed | Extra user fields: `locale`, `time_zone`, `behavioral_learning_opt_out`, consent flags |
| `profile` | `user_id` PK; stage, depth/format/time prefs, `version` | Bump `version` on every edit |
| `goal` | `id`, `user_id`, text, `active`, `embedding vector` | Goal text is sensitive; encrypted at the application level (see §8) |
| `topic_weight` | `(user_id, topic)` unique; weight, `origin` (explicit / learned) | Learned weights are shown in Preferences with their evidence |
| `schedule` | `user_id` PK; frequency, weekdays, `local_time`, `time_zone`, item count/mix, channels, `short_letter_policy` (shorten/skip), `paused`, `skip_next`, `next_run_at` (UTC, precomputed) | `next_run_at` is recomputed in the user's tz after every run or edit (DST-safe) |
| `publisher` | `domain` unique (or channel ID for video); name, `feed_url` (autodetected), `status` (`candidate` / `trial` / `trusted` / `blocked`), `origin` (user_added / discovered), quality stats as counts (items seen, extractions ok/failed, verifications passed/failed, interested/not-interested votes, substantive/low-quality items), `status_reason`, `status_changed_at`, `evaluated_at`, `feed_checked_at`, `first_seen_at` | The growing publisher catalog (§6.3a). Shared across users; per-user preference lives in `user_source` and reviews. |
| `source` | `canonical_key` unique (feed URL / channel ID / domain); `publisher_id`, type, creator, `rights_rule_id`, `next_fetch_at`, `last_fetch_status` | Shared across users |
| `user_source` | `(user_id, source_id)` unique; mode (`more_like_this` / `follow_closely` / `occasional`), `blocked` | |
| `rights_rule` | scope (domain/source), `display` = `full_text` / `excerpt_only` / `link_only`, `retain_text` bool, `license_note`, `offline_allowed` | **Personal-use mode (current): default is `full_text`, retained, offline allowed.** The table stays so rules can be tightened if the app is ever shared. |
| `discovery_run` ✅ | `(user_id, occurrence_id)` **unique**; `letter_due_at`, `status`, `inputs_hash`, query `method`/`model`/`prompt_version`, counts (queries generated, billed searches, cache hits, pages linked, pages queued) | One discovery pass per letter occurrence (§6.3a); the unique key makes overlapping sweeps start it once |
| `discovery_query` ✅ | `run_id`, `user_id`, `position`, query text, `normalized_query`, `origin` (role / lately / topic / fact / review / leaning) + `origin_detail`, `inputs_hash`, `method`/`model`/`prompt_version`, `status` (searched / cached / skipped_recent / skipped_stale / skipped_cap / duplicate / failed), `search_id`, `result_count`, `accepted_count`, `ran_at` | Every generated query, including skipped ones. Lets us see which queries find good material, and avoid repeating stale ones |
| `discovery_search` ✅ | `normalized_query` **unique**; results JSONB (`url`, `title`, `reason`), `web_searches`, `method`/`model`/`prompt_version`, `searched_at`, `expires_at` | Shared search cache across users (7-day TTL) |
| `user_discovery` ✅ | `(user_id, item_id)` **unique**; `query_id`, `reason`, `found_at` | The per-user link that makes a discovered `content_item` a letter candidate |
| `user_publisher` ✅ | `(user_id, publisher_id)` **unique**; `blocked`, `blocked_reason` (`user` or `votes:<rule>`), `blocked_at` | A user's own block of a publisher; the vote rules never override the user's own choice |
| `content_item` | `canonical_url` unique; type, creator, published_at, language, `embedding`, `quality_label`, `icon`, `status` | Stable canonical ID reused across letters (§11) |
| `content_version` | `(item_id, content_hash)` unique; `fetched_at`, `blocks_s3_key` (null unless permitted), section map JSON, `rights_snapshot` | A new version is created when the content hash changes |
| `transcript` | `item_version_id`; `provider`, `provenance`, `confidence`, `s3_key` | No row → video can be saved but gets no skim |
| `letter` | `(user_id, occurrence_id)` **unique**; scheduled_for (UTC + local date), `status`, `step_attempts`, `generation_meta` (prompt/model versions), `why_this_mix`, `postscript_default` (the P.S. written with the letter), `postscript_recap` + `postscript_recap_signature` + `postscript_recap_meta` (the P.S. rewritten from feedback, §6.5) | The core duplicate-delivery guard |
| `letter_item` | `(letter_id, item_id)` unique; `(letter_id, feedback_code)` unique; `position`, **`snapshot` JSONB** (interesting line, personal line, actions, evidence refs, goal version, contents icon), `pick_signals` JSONB | The snapshot preserves the historical copy (§5) |
| `interaction` | `event_id` **unique** (client UUID); `user_id`, `item_id`, `letter_id`, `type` (open/complete/uncomplete/save/unsave/summary_expand), `occurred_at`, **`local_day`** | `local_day` is set by the client when the event happens and never recomputed (§9) |
| `review` | `(user_id, item_id)` **unique**; vote, reasons[], free_text, `edited_at`, `origin` (in_app / imported) | Upsert; free text encrypted at the application level |
| `summary` | `(item_version_id, section_id, format)` unique; text, `evidence_refs`, model, prompt version | Shared cache (not user-specific) |
| `action_suggestion` | `user_id`, `item_id`, `goal_version`, text, `evidence_ref`, state (saved/done/not_useful) | Separate from reading-preference signals (§8) |
| `delivery_attempt` | `(letter_id, channel)` **unique**; status (`pending` / `sent` / `failed`), provider message ID, `sent_at` | Claimed with `SELECT … FOR UPDATE` before calling SES/SNS |
| `push_token` | `(user_id, device_id)` unique; platform, native token, SNS endpoint ARN | |
| `takedown` | scope, reason, `applied_at` | Applying one purges S3 blocks and excludes the scope from future letters |

---

## 6. Core mechanics

### 6.1 Scheduling and idempotent delivery (§10)
1. The **sweep** runs every 5 minutes. It claims due work with `FOR UPDATE SKIP LOCKED`, so overlapping sweeps are safe:
   - schedules where `next_run_at - assembly_lead (45 min) <= now()` and not paused;
   - letters in `ready` whose `scheduled_for <= now()`;
   - sources where `next_fetch_at <= now()`;
   - a **watchdog** for letters stuck in a step longer than N minutes (re-enqueue, or fail after the attempt limit).
2. `occurrence_id = <local date>#<schedule version>`. The sweep does `INSERT … ON CONFLICT (user_id, occurrence_id) DO NOTHING`, and only a newly inserted row triggers the first `letter-step` message. This is how retries avoid creating a second letter.
3. `skip_next` consumes one occurrence (it's recorded as a `skipped` letter so history is honest). A **test letter** uses `occurrence_id = test#<uuid>` and doesn't touch `next_run_at`.
   - **The first letter** is made when onboarding is finished (`POST /me/onboarding/complete`), not by the sweep: `occurrence_id = first`, so there's at most one per user however often onboarding is completed. It's a real letter (`is_test = false`, it becomes Letter No. 1), `scheduled_for = now()`, and like a test letter it doesn't touch `next_run_at` or the regular schedule. Because a new user follows nothing yet, it waits for a discovery run first (§6.3a, "Letters that wait for discovery").
4. **Sending:** the deliver handler claims the `delivery_attempt` row per channel. If it's already `sent`, the handler returns without sending. It calls SES/SNS, then marks the row `sent` with the provider message ID. A crash between the SES call and marking the row can theoretically cause one duplicate. SES's `SendEmail` has no idempotency key, so this window is minimized, not eliminated. An alarm counts provider message IDs per attempt.

### 6.2 Letter pipeline (no Step Functions)
The status column is the state machine:
`scheduled → collecting → ranking → generating → verifying → ready → sending → sent`, plus terminal states `short_sent`, `skipped_no_candidates`, and `failed`.

Every `letter-step` message is `{letterId, expectedStatus}`. The handler first runs `UPDATE letter SET status = next WHERE id = $1 AND status = $expected RETURNING *`. If no row comes back, the message is a duplicate or stale and is acknowledged without doing work. Each step writes its output (candidate set, ranked picks, generated snapshots) before advancing, so re-running a step after a crash is safe.

- **collect:** candidates from followed sources, discovered items (§6.3a) and pasted URLs, minus blocked items, already-delivered items (per user), broken or inaccessible items, and videos without transcripts (§6.3).
- **rank:** scoring and rerank (§6.4).
- **generate:** per-item copy with evidence (§6.5).
- **verify:** deterministic checks plus a model check. Failures are substituted from the ranked reserve list. If too few items remain, the user's policy applies (short letter or skip).
- **lock:** assigns feedback codes (§6.7), writes the snapshots, sets `ready`.

A letter can be **held in `scheduled`** (`letter.awaiting_discovery = true`) while a discovery run with the same occurrence ID searches for it (the first letter, and a test letter with too little to pick from). Nothing queues its first `letter-step` until it's released; its `watchdog_at` is the latest it may wait (§6.3a).

### 6.3 Ingestion and rights (§6 steps 1–3, §7)
- **Adapters** in `packages/ingest`: RSS/Atom, single URL, sitemap/site, YouTube channel (via the Data API for listings), and **web-search discovery** (§6.3a). Each adapter declares its rate limit. The queue `maximum_concurrency` plus a per-domain `last_fetched_at` check enforce politeness.
- **Canonicalization:** resolve redirects, strip tracking params, respect `<link rel=canonical>`, normalize host and trailing slash. Near-duplicate detection uses a SimHash of the extracted text to collapse reposts and editions.
- **Extraction:** fetch → Readability (on a lightweight DOM) → sanitize → **block JSON** (`heading | paragraph | quote | list | image | caption | table`) with a section map. A Chromium-in-Lambda fallback handles JS-rendered pages.
- **Rights gate** (deterministic, in `packages/core`): the rule decides whether blocks are **retained** (S3) and **displayed**. **For personal use, every source defaults to full text, retained and available offline.** The gate and the digest mode are still built (they're cheap) so rules can be tightened later without a redesign. Paywalls and failures produce a metadata-only item with an explicit reason code; nothing is ever generated from a title alone.
- **Enrich (Claude via the Message Batches API at 50% off, plus embeddings):** enrichment isn't time-critical, so new items are batched every few minutes. Results normally arrive well within the hour; the API allows up to 24 h, so an item stays out of letters until it's enriched. It uses Haiku 4.5 to produce 2–4 topic tags, language, depth and read time, and a quality label (original and substantive vs. thin, rewritten or SEO filler), plus an embedding. It also picks the icon shown beside the piece in a letter's contents, one key from a fixed list of about 60 (`pieceIconKeys` in `@fs/schema`: pricing, hiring, fundraising, ai, …; the app maps keys to glyphs), stored on `content_item.icon`; a pick off the list is stored as null (prompt `enrich-v2`). Items without one (enrichment off, or enriched before icons) get one from keyword rules over their tags, the piece's topic and title (`fallbackPieceIcon` in `@fs/core`), else "article" / "video". Lock snapshots the resolved icon so a delivered letter keeps it; snapshots from before icons are resolved on read.
- **Transcripts:** `TranscriptProvider.get(videoId) → {segments, provider, kind: 'native' | 'generated', confidence} | null`, stored with its provenance. A low-confidence result is treated as unavailable.
  - **Primary: Supadata.** It returns the video's existing captions (1 credit) and can AI-transcribe a video that has none (2 credits per minute). Free tier: 100 credits/month; paid plans from $5/month. Personal use (a few videos a day, captions only) fits in the free tier.
  - **Backup: TranscriptAPI.com** (~$5/month for 1,000) or **Apify's YouTube transcript actors** (~$3 per 1,000, charged only for successful results). Either can be swapped in behind the interface.
  - **Why not fetch captions ourselves:** YouTube blocks requests from cloud IP ranges (AWS included), so libraries like `youtube-transcript-api` fail from Lambda unless routed through paid residential proxies. The official YouTube Data API only downloads captions for videos you own. These services handle the blocking for us, but they rely on unofficial access, so they can break without warning. Keeping the provider swappable is the mitigation.
  - We use **native captions only** by default, and AI-generated transcripts only when a video has no captions and the user saved it explicitly (it costs more credits).

### 6.3a Open discovery and the publisher catalog
The app **doesn't depend on a fixed list of publishers**. It searches the open web for what each user wants, and builds up a catalog of publishers as it goes. Known-good publishers become cheap to follow, while every letter keeps room for new ones so the pool keeps growing.

1. **Query generation (Haiku 4.5, structured output).** From the user's goals, topics, recent "interested" reviews and their reasons, it writes a handful of specific search queries (e.g. "case study moving from consulting to productized service pricing"). Queries are logged in `discovery_query`, and ones that recently found nothing are skipped.
2. **Search (Sonnet 5.5 + Claude's web search tool).** The `discover` worker runs the queries with the web search tool, using `blocked_domains` for known content farms and publishers the user blocked. It **doesn't use an allowlist**, so any site can be found. Claude returns a structured list of candidate URLs with a one-line reason each. It never writes letter copy from search snippets.
3. **Normal ingestion.** Each candidate URL goes through the same pipeline as everything else (clean up the URL, deduplicate, extract, check rights, enrich), so discovered items get stable IDs, full text and verified summaries like any other item.
4. **Publisher catalog.** The first time a domain appears, it's added to `publisher` with status `candidate`, and its RSS feed is autodetected (from `<link rel="alternate">` or common paths).
   - Its stats update over time: whether its pages extract cleanly, whether its content passes claim verification, how the enrichment step rates its quality, and how users vote on its items.
   - `candidate → trial` after it produces a well-rated item. `trial → trusted` after several good items. A **trusted publisher with a feed is polled directly**, which is cheaper than searching for it again.
   - Publishers with repeated low quality, failed verification or negative votes become `blocked` (for that user if it's their vote, globally if it's a quality failure).
5. **Keeping the pool growing (explore vs. exploit).** Ranking treats publishers like a multi-armed bandit: each has a score estimated from its record, with uncertainty. A new publisher with little history gets the benefit of the doubt, so it has a real chance to appear. The **exploration slot** in every letter (§6.4) is filled from `candidate`/`trial` publishers, so users keep seeing new sources rather than the same few.
6. **Budget.** Discovery runs per user a few hours before each letter, with a cap of about 5–10 searches per letter. At $10 per 1,000 searches plus tokens, that's roughly a few cents per letter. Results are cached across users with overlapping topics.

**Built (M3) ✅** — `apps/workers/src/discovery/` (the `discover` worker, sweep hook, catalog pass), `packages/core/src/discovery.ts` (every rule and cap, unit-tested), `packages/ai/src/discovery.ts` (query generator and web searcher, API and local CLI), migration `0006_discovery`, `GET/PATCH /me/publishers`, and the `discover` Lambda and queue in Terraform. How a run flows:

1. The 5-minute sweep inserts a `discovery_run` for each schedule whose next letter is due within `DISCOVERY_LEAD_HOURS` (3) but isn't being assembled yet (`ON CONFLICT (user_id, occurrence_id) DO NOTHING`, the letter's own occurrence key) and queues `discover`. Skipped or paused occurrences get none. The first letter and some test letters get one from the API instead, and wait for it (below). `pnpm --filter @fs/workers discover <email>` runs one by hand.
2. The worker claims the run, loads the brief (role, "lately", explicit topics, kept imported facts, the last 90 days' "interested" reviews with reasons, the previous letter's chosen leanings; never name or email), and applies the user's vote rules to `user_publisher`.
3. Haiku 4.5 writes up to 8 queries (on failure, deterministic queries from the brief, recorded as `method = fallback`). `selectQueries` keeps at most 4, skipping duplicates, queries this user ran in the last 7 days, and queries that found nothing new in the last 21. All of them are logged in `discovery_query`.
4. Each kept query is served from `discovery_search` when a fresh entry exists (any user's), else searched: Sonnet 5.5, `web_search_20260209` with `max_uses: 2`, `blocked_domains` (content farms, globally blocked publishers, the user's blocked publishers; capped at 60, the rest filtered after), effort `low`, structured output of `{url, title, reason}`. URLs that weren't in the search's own result blocks are dropped.
5. Results are filtered again for this user (blocked hosts, homepages, YouTube, repeats), then each page is linked: its publisher is upserted as `discovered`/`candidate`, the page becomes a `content_item` (deduplicated on canonical URL; no title from the search), a new one is queued to `extract`, and a `user_discovery` row records the query and reason. At most 15 pages per run.
6. Extraction is the normal pipeline (SSRF-safe fetcher, canonical URL, SimHash dedupe, rights, enrichment). On a discovered publisher's first extracted page, `autodetectFeed` looks for its feed (advertised by the page, then by its homepage, then common paths; at most 6 fetches, same site only).
7. The sweep's catalog pass re-evaluates discovered publishers hourly: it recomputes quality and vote counts from their items and applies `publisherVerdict`. A newly trusted publisher with a feed gets a shared `source`, which the sweep polls although nobody follows it.
8. Collect unions followed-source items, the user's discovered pages (found in the last 14 days, whatever their publish date) and new items from trusted discovered publishers the user was shown. Rank adds `discovered` (detail: the search's reason), `publisher_record` and `exploration` pick signals and fills the exploration slot. Lock records a verification pass or failure on each piece's publisher.

**Letters that wait for discovery (the first letter)**

A new user follows no sources, so collect would find nothing and their first letter would end `skipped_no_candidates`. So letters made on demand search the web first:

1. **Which letters.** The first letter (`first`, made by `POST /me/onboarding/complete`) always; a test letter (`test#<uuid>`) when the user has fewer fresh candidates than their letter's item count (followed-source items from the last 60 days plus discoveries from the last 14, not yet in a letter or reviewed: a cheap version of collect's rules, `hasEnoughToPick` in the API). With `DISCOVERY=none` (or enough candidates) the letter starts straight away, as before.
2. **Creation (API, one transaction).** The letter is inserted `scheduled` with `awaiting_discovery = true` and `watchdog_at = now() + HELD_LETTER_MAX_MINUTES` (10), plus a `discovery_run` with the **same occurrence ID** (`ON CONFLICT DO NOTHING` on both, so finishing onboarding twice makes one letter and one run). On AWS the API then queues `discover` (send-only on that queue); no `letter-step` is queued. Locally the API can't reach the dev runner's in-memory queues, so it only writes the rows.
3. **Starting the run.** Every letter sweep (5 minutes on AWS, every 5 s in `pnpm dev:workers`) queues `discover` for any pending run a held letter waits on. On AWS that only repeats a lost message (a duplicate finds the run claimed); locally it's how the run starts. With discovery off in the workers, such runs are marked `failed` ("discovery is off").
4. **One attempt.** A run a letter waits on isn't retried through the queue: if it throws, it's marked `failed` (with `finished_at` and the error) and the letter goes ahead with what there is. A run that ends normally is `done` (an empty brief is `done` too).
5. **Release.** A held letter is released (flag cleared, `watchdog_at` = step lease, first `letter-step` queued) once its run is `done` or `failed` **and** none of the pages that run linked (`user_discovery` via `discovery_query.run_id`) are still `pending` extraction, waiting at most `HELD_LETTER_EXTRACTION_WAIT_MINUTES` (3) after the run finished. Found pages only become candidates once extracted (collect needs `extracted`/`enriched` with a title), which is why it waits for them. The check (`releaseHeldLetters`, `FOR UPDATE SKIP LOCKED`, guarded by the flag so a letter is released once) runs when a run ends, after every extraction, and on every sweep. The `discover` and `extract` workers may therefore send to `letter-step`.
6. **Backstop.** If the run never ends (a crashed worker whose lease hasn't run out, a lost message, a DLQ), the watchdog finds the held letter once `watchdog_at` (creation + 10 minutes) has passed, clears the flag and starts it anyway. On AWS the sweep runs every 5 minutes, so that's 10–15 minutes at worst.
7. **The app.** `POST /me/onboarding/complete` returns `firstLetter` and the test-letter route returns `progress` (`LetterProgress`: `searching` while the run is pending or running, `reading` while waiting for extraction, `writing` once released, then `sent`, `empty` or `failed`). Today follows that letter by polling `GET /letters/:id/progress` every 3 s, and opens it when it's sent.

**Decisions made while building §6.3a**
- **Caps** (constants in `packages/core/src/discovery.ts`): 3 h lead; 8 queries generated, 4 searched per letter, `max_uses` 2 each, so at most **8 billed web searches per letter**; 6 results per query; 15 pages linked per run; cache TTL 7 days.
- **Cost check:** the searches themselves are ≤ $0.08 per letter, but each search call also reads its results as Sonnet input tokens (dynamic filtering trims them). Expect very roughly $0.05–0.30 per letter before cache hits, which is above "a few cents". Measure it from `usage` in M3; the caps are the lever.
- **Shared cache** is keyed by the normalized query (stemmed keywords, sorted), so rewordings share a search. A result the first searcher's blocks removed is missing for the next user (acceptable); each user's blocks are re-applied on read.
- **"Well-rated item"** = enrichment labelled it `substantive`, or a user voted it interested. candidate → trial at 1 good item (and more good than bad); trial → trusted at 4 good with ≤ 25% bad. Only discovered publishers are moved; user-added ones aren't.
- **Global blocks are for quality only:** ≥ 3 low-quality items (and more than substantive ones), ≥ 3 failed verifications (and more than passed), or < 25% of pages extracting after ≥ 4 tries. **Votes block per user only:** 2 "not credible"/"too promotional" votes, or 3 not-interested votes (not counting "not my topic"/"already knew") with none interested. Blocks don't lift automatically; a user's own block or unblock is never overridden.
- **Verification record** counts the letter's copy checks per piece (kept vs. rejected), which partly reflects the writer rather than the publisher. Good enough as a signal; revisit with the model check (§6.5).
- **Explore vs. exploit:** one exploration slot when a letter has ≥ 2 pieces, for the best piece from a discovered `candidate`/`trial` publisher the user doesn't follow, and only if it fits the user (score without recency and discovery bonuses ≥ 1, i.e. at least a leaning, "lately" or topic match). Uncertainty bonus = 1/√(1 + evidence); record = (good − bad)/(good + bad + 2). The P.S. leaning "Something new" now matches these pieces.
- **Discovered pages stay candidates for 14 days after they're found**, not by publish date, since good finds are often evergreen.
- **YouTube results are skipped** for now (no channel ID without the Data API); discovery is for articles.
- **"Why I picked this":** the search's reason stays in the pick signals and goes to the writer as a `discovered` signal, which may say it's a new find but never repeats the note's claims (prompt `letter-v2`). The fallback copy says "A new source, found by searching the web for what you're into." Discovered pieces may carry the "New source" tag.
- **Locally**, `DISCOVERY=claude-cli` (the default) runs both calls through the Claude Code CLI like the other local model calls. Its WebSearch tool can't take a block list, so blocked domains go in the prompt and are filtered afterwards; it reports 0 billed searches.

### 6.4 Ranking v1 (§6)
A transparent, weighted heuristic. It's explainable, and the eval set can tune it later.

`score = w1·goal_similarity + w2·source_mode + w3·review_topic_affinity + w4·creator_affinity + w5·novelty + w6·timeliness + w7·depth_fit + w8·time_fit + w9·credibility − w10·repetition_penalty`

- Reviews with written reasons carry the most weight. Saves, completions and summary expansions carry less. Unopened items are ignored and dwell time is not used (§6). If the user has opted out of behavioral learning, only explicit signals and reviews count.
- **Rerank** greedily under constraints: at most 1 item per publication, the configured mix (default 3 articles + 2 videos), a total time budget, 1 exploration slot (filled from new publishers, §6.3a), and diversity across topics.
- Each pick stores its **top contributing signals** as structured data. The Reader turns them into "Why this was picked" sentences, never showing raw scores.
- **Negative reasons:** Haiku 4.5 (structured output) parses the free text into structured signals (topic, creator, depth, format, …). These adjust `topic_weight` and similar. The next letter's `why_this_mix` names the change (e.g. "Fewer beginner-level growth pieces, per your feedback on 12 Oct").

### 6.5 Generation and verification (§5, §8, §12 AI)
- **Anthropic Messages API with structured outputs** (`output_config.format` with a JSON schema generated from the zod schema), so responses always match the expected shape. We still parse them with zod as a second check. Prompt caching covers the stable system prompt and the user's profile block. Every call checks `stop_reason`, handling `refusal` with the server-side fallback (`fallbacks: "default"`) and `max_tokens` with a retry.
- **Inputs and outputs.** The inputs are retrieved passages with IDs, the active goals and stage, and the item metadata. The output is `interesting {text, evidence_ids}`, `personal {text, goal_id}`, `actions[0..2] {text, evidence_ids}`, and a short summary.
- **Deterministic checks:** every `evidence_id` exists; every number, date and quoted string appears in the cited passages; URLs match the canonical item; the output contains no invented biographical claims (checked against profile fields).
- **Model check (Sonnet 5.5, low effort):** a per-claim "supported / unsupported" judgment against the cited passages, a genericness check on actions, and a redundancy check across the letter.
- Items that fail are regenerated once, then substituted.
- The prompt version, model ID and a hash of the input are stored on the letter, so any letter can be reproduced.
- **The P.S. recap.** By default it's a quick summary of the letter's pieces, written by the letter writer in the same call (`postscript`, prompt `letter-v3`): two or three short sentences, under about 60 words, naming each piece by title in curly quotes, with nothing beyond the pieces' summaries and no exclamation marks. `checkPostscript` verifies it (length cap; it quotes only the letter's titles and names each one; its numbers appear in a title or summary). Lock stores it as `letter.postscript_default`. If a piece was substituted, or the text fails the checks, a deterministic one from the titles is stored instead ("Today was “A”, “B” and “C”. Tell me which were worth your time."). The fallback writer writes the same thing. Letters locked before this get that one on first read.
- **The cover intro** is a personal hook, written by the letter writer in the same call (`intro`, prompt `letter-v4`): one or two short sentences (aim under 140 characters, cap 200) speaking to the reader as "you", tying something from their brief (role, lately, topics, chosen leanings) to what's specifically inside one or more of the letter's pieces, without hype, rhetorical questions or exclamation marks, and without recapping every piece (the P.S. does) or explaining the mix (why this mix does). `checkLetterCopy` verifies it: length cap; its numbers are the piece count, minutes, or appear in a pick's title or passages (a concrete figure is often the best hook, and it's still pinned to the pieces' own text); its quotes are the user's words or a pick's title; no exclamation marks outside a title; no links. If a piece was substituted or the checks fail (logged as `letter_copy_rejected`), `fallbackIntro` writes one from the brief and the picks, leading with the pick tied to what they're into lately or a chosen leaning, else their role: "You said you're into “getting off hourly billing”: start with “Price the outcome”, then two more on hiring and sales. 18 minutes in all." It drops the topics, then the hook, to fit the cap, and as a last resort says "Three things I picked for you. 18 minutes in all."
- The recap is **rewritten only on feedback**: a verdict either way on one of the letter's pieces, with its reasons (skips don't count). It's written lazily when the letter is read (`GET /letters/today` and `/letters/:id`), by Haiku 4.5 (`reader.recap`, prompt `recap-v2`) from all the pieces with their verdicts and reasons, and checked the same way (without requiring every piece to be named). It's cached in `postscript_recap` under a signature of the prompt version and every verdict and reason, with `postscript_recap_meta` (method, model, prompt version, fallback reason). Concurrent reads in one process share one call. When the model fails or its text fails the checks, a plain recap is written from the user's own reasons. With no feedback, the default is returned with no model call, and removing all feedback clears the cached recap so the default shows again. In the app, a verdict refetches the letter, so the P.S. page shows the new recap.
- **Section summaries** are generated on demand via `POST /items/:id/summary`: the API returns a cached summary when one exists. Otherwise it generates synchronously (short sections) or enqueues and returns `202` for the client to poll. Output is structured as claim / evidence / qualification / implication-for-me, with an opinion label where relevant. The "implication-for-me" part is user-specific and is **not** stored in the shared cache.

### 6.6 Activity (§9)
- The client records `local_day` when the event happens. The server never recomputes it, so a later time-zone change doesn't rewrite history.
- The intensity for a day = the count of **distinct items** with an `open`+`complete` or a review that day, bucketed into 4 levels. Plain `open` events are listed in the day sheet but don't drive intensity. (Confirm this counting rule — §12.)
- `uncomplete` cancels an accidental completion. Streaks are off by default, and paused periods don't count against them.

### 6.7 Feedback codes
Codes follow the pattern `[A-Z]{2}[0-9]{2}` and are unique within a letter. They're generated at lock time, skipping ambiguous characters (`O/0`, `I/1`) and any letter pair that matches the item's publication initials. No publisher badge is rendered anywhere (§5, §14 acceptance).

---

## 7. API (Hono)

Implements spec §13 plus what the plan needs. All routes use zod validation; the Expo app uses Hono's `hc<AppType>` typed client.

| Route | Notes |
|---|---|
| `/api/auth/*` | Better Auth: email magic link (via SES), Sign in with Apple, Google. Apple sign-in is required on iOS whenever other social logins are offered. |
| `GET/PUT /me/preferences`, `GET/PUT /me/schedule` | Recomputes `next_run_at` on write |
| `POST /me/schedule/test-letter`, `POST /me/schedule/skip-next` | A test letter searches the web first when there's too little to pick from (§6.3a); returns `{letterId, progress}` |
| `POST /me/onboarding/complete` ✅ | Marks onboarding done and makes the first letter (`first`, once per user; discovery first). Returns `{profile, firstLetter}` |
| `GET /letters/:id/progress` ✅ | Where an on-demand letter has got to: `searching`, `reading`, `writing`, `sent`, `empty`, `failed` |
| `POST /me/sources`, `GET /me/sources`, `PATCH/DELETE /me/sources/:id` | Returns validation and rights status |
| `GET /letters/today`, `GET /letters?cursor=` | |
| `GET /items/:id` | Rights-aware blocks/digest, section map, the letter snapshot (by `?letter=`), pick explanations, `rights`/`status` flags |
| `POST /items/:id/summary` | `{sectionId, format}`; returns 200 (cached) or 202 (pending) |
| `PUT /items/:id/review`, `DELETE /items/:id/review` | Idempotent upsert |
| `POST /events` (batch) | Client UUID `event_id`s; ignores duplicates |
| `PUT /actions/:id` | saved / done / not_useful |
| `GET /me/activity?from=&to=`, `GET /me/activity/:day` | |
| `GET /me/reviews` | Feedback history |
| `POST /me/push-tokens` | Registers a native token and creates or updates the SNS endpoint |
| `POST /me/export`, `DELETE /me` | Export is asynchronous (S3 presigned link by email). Deletion is required in-app by Apple. |
| `GET /i/:itemId` | Server-rendered web fallback page (title, credit, digest excerpt, source link, app store links) |
| `POST /client-logs` | Batched error reports from the app; written to a dedicated CloudWatch log group. Rate-limited per user |
| `GET /me/publishers`, `PATCH /me/publishers/:id` ✅ | See discovered publishers, then follow (`{following}`: adds its feed as a source) or block (`{blocked}`, per user) them. Mute is the source's `occasional` mode once followed |

**Error model:** `{code, message}`, where `code` is one of `SOURCE_UNAVAILABLE | FULL_TEXT_UNLICENSED | TRANSCRIPT_MISSING | GENERATION_FAILED | NOT_FOUND | …`. `OFFLINE_CACHE_MISS` is generated on the client (§13).

---

## 8. Mobile app (Expo)

- **Navigation:** Expo Router tabs: Today · Library · Activity · Preferences. Stack routes for Reader, Feedback history, Onboarding, Source add, and "Why this was picked".
- **Onboarding:** stage → goals (presets + free text) → time budget and topics (seek/avoid) → sources (paste URL/RSS/YouTube, choose mode, optional loved/disliked examples) → schedule and channels → push permission (asked here, in context) → test letter.
  - **As built (M2, revised):** import from your AI → a fill-in sentence ("I'm a ___. Lately I've been into ___. Send me more on ___. Send it ___.") under a live letter preview → **"Send my first letter"**, which finishes onboarding, makes the first letter (§6.1, §6.3a) and opens Today, where the user watches it being put together and then reads it. **Removed at the user's request:** the "I follow people on ___" / "Where do you already read?" step (the import may still fill `profile.platforms` from facts; it's kept, never asked), and the five calibration swipes after the sentence (the SwipeDeck, `GET /me/onboarding/picks`). Reviews keep `origin = onboarding` in the database for older rows, but clients can no longer send it.
- **Reader:** a `BlockRenderer` maps block JSON to native components (Text with dynamic type, Image with caption, Table as a horizontally scrollable card rather than the page, Quote). Digest mode has a persistent "Digest — not the original text" label. The section rail/index appears on tablets, and "Summarize section" works inline. Video uses an embedded player where permitted, plus the transcript skim and chapters. Sticky controls sit clear of the content and account for the safe area.
- **Offline:** SQLite holds cached letters, permitted blocks (only where `offline_allowed`), reading progress, and an **outbox** (reviews, events, action states) with client UUIDs. A sync loop flushes the outbox on reconnect and on app foreground. TanStack Query uses SQLite-backed persistence.
- **Push and deep links:** `expo-notifications` `getDevicePushTokenAsync()` provides the native APNs/FCM tokens that SNS needs. Universal links and App Links on the links domain route `/i/:itemId?l=:letterId` to the Reader.
- **Accessibility:** dynamic type up to the largest sizes without clipping, screen-reader labels on every card and control, reduced motion, dark mode, 44pt minimum tap targets, and an activity grid with a text summary and list view.
- **Error reporting (CloudWatch):** a root error boundary plus a global JS error handler catch errors. Each report includes the stack trace, app version, EAS Update ID, OS and screen, and goes into a small queue in SQLite that's sent in batches to `POST /client-logs`. The API writes them to the `/founder-signal/mobile` log group as structured JSON, so CloudWatch Logs Insights can query them and a metric filter can alarm on spikes. **Limitation:** this catches JavaScript errors, not native crashes. Those only appear in Xcode Organizer / TestFlight and the Play Console. That's fine for personal use; a dedicated crash reporter can be added later.
- **Release:** EAS Build (dev client, preview, production profiles) and EAS Submit, with EAS Update for JS-only fixes. Environment is set per build profile.

---

## 9. Quality, security and operations

**Testing**
- `packages/core`: exhaustive unit tests covering DST and time-zone schedule cases, feedback-code generation, rights decisions, rerank constraints and activity bucketing.
- API: `app.request()` tests against a real Postgres (Docker in CI).
- Pipeline: an end-to-end run in `dev` with fixture sources (a mocked HTTP origin serving articles, a paywall, a 404, and a video without a transcript).
- **Generation eval set:** about 50 articles × 5 goal profiles, with golden checks for unsupported-claim rate, generic-action rate and relevance. It runs in CI on prompt or model changes.
- Mobile: Maestro flows for onboarding → test letter → read → summarize → review offline → sync.

**Security and privacy**
- TLS everywhere; KMS encryption at rest (RDS, S3, SQS).
- Application-level envelope encryption (KMS data key) for goal free text and review free text.
- IAM roles are scoped per Lambda. Only the API, letter and enrich Lambdas can read the Anthropic API key secret or call Bedrock embeddings (`bedrock:InvokeModel` on the embedding model ARN only).
- **Fetching user-supplied URLs (SSRF protection):** the fetch Lambdas resolve each hostname and refuse private, loopback and link-local addresses (including `169.254.169.254`) before connecting and again after every redirect. They allow only http(s), set response-size and timeout caps, and don't follow redirects to other schemes.
- Anthropic doesn't train on API inputs by default, and neither does Bedrock (for embeddings). No shared model is trained on user data (§12). Only the minimum user context goes into prompts: goals, stage and topics, never email or name.
- Export and deletion: deletion cascades user rows, S3 exports and SNS endpoints.

**Alarms**
- DLQ depth > 0 on any queue.
- Letters not `sent` within 10 minutes after `scheduled_for`.
- Duplicate `delivery_attempt` sends (provider IDs > 1 per attempt).
- Extraction failure rate per source.
- Unsupported-claim substitution rate.
- Claude tokens and spend per day (from `usage` on every response, published as metrics), plus a spend limit set in the Anthropic Console.
- SES bounce/complaint rate (SES suspends accounts above thresholds).
- Fallback-page hits (a proxy for deep-link failures).
- API 5xx and p95 latency.
- Mobile error rate (metric filter on the mobile log group).
- Discovery: searches per day and share of discovered items that pass quality checks.

---

## 10. Milestones

Estimates assume 2 engineers (1 mobile-leaning, 1 backend-leaning). Solo, and learning AWS along the way, expect roughly double.

| # | Milestone | Weeks | Deliverables | Exit check |
|---|---|---|---|---|
| **M0** | Foundations | 1–2 | AWS dev project (ap-southeast-2), Terraform bootstrap, network, RDS, API Lambda, CI/CD, monorepo, Expo shell with tabs, Better Auth sign-in end to end, `/client-logs` → CloudWatch. **Long-lead items started:** SES production access, Apple Developer and APNs key, Firebase project, links domain, Anthropic API organization and spend limits, Bedrock embedding model access, Supadata account. | Sign in on a device against `dev`; `terraform plan` clean in CI |
| **M1** ✅ | Ingestion | 3–5 | Source add API, RSS/URL/YouTube adapters, canonicalization and dedupe, extraction to blocks, rights rules (personal-use defaults), Supadata transcript provider, enrich (tags, embeddings), publisher table and feed autodetection | Adding 3 real sources yields items with correct rights flags; a paywalled URL produces a metadata-only item |
| **M2** | Profile and onboarding | 4–6 | Onboarding flow, preferences/schedule API, goals and topics, `next_run_at` computation. Revised: no platforms step and no calibration swipes; finishing sends the first letter at once (discovery first, §6.3a) | A new user finishes onboarding in under 3 minutes |
| **M3** | Letter engine and discovery | 6–9 | Sweep, occurrence idempotency, collect/rank/generate/verify/lock, pick signals, test letter, eval set v1, **web-search discovery and publisher promotion (§6.3a)** (discovery ✅) | **Acceptance #1** (test letter with no operator work); duplicate-sweep chaos test yields exactly 1 letter |
| **M4** | Reader and feedback | 8–11 | Today, Reader (blocks/digest/video), section summaries, reviews with reasons, save, events, outbox sync, feedback history | **Acceptance #4** (offline review found after sync); **#5** (no invented text) |
| **M5** | Delivery | 10–12 | SES email template, SNS push, deep links + fallback page, pause/skip/test, bounce handling | **Acceptance #6** (retry storm yields no duplicate letters or notifications) |
| **M6** | Library, activity, explainability | 11–13 | Library + search, activity grid + text/list views, learned-signal explanations, negative-reason loop | **Acceptance #2** (next letter changes after reasoned dislike, and the app says why); **#7** (grid matches events) |
| **M7** | Hardening and launch | 13–16 | Accessibility audit at large text sizes, takedown flow, export/deletion, alarms, cost test, TestFlight / Play internal testing, App Store review | **Acceptance #3** and **#8**; all spec §14 acceptance checks pass in `prod` |

Critical path: **M0 long-lead items → M1 → M3 → M5**. The mobile work (M2, M4, M6) runs in parallel against a mocked API built from `packages/schema` until the real endpoints exist.

---

## 11. Rough monthly cost (dev, low volume)

These are ballpark figures to be checked in the AWS Pricing Calculator.

| Item | Approx. |
|---|---|
| RDS Postgres (small Graviton instance, single-AZ in dev) | $15–30 |
| RDS Proxy (billed on the DB's vCPUs, with a minimum) | ~$20 (can skip in dev) |
| NAT: fck-nat instance in dev, incl. public IPv4 (managed NAT gateway ~$37 + data in prod) | ~$7 |
| Lambda, SQS, S3, CloudFront, API Gateway, EventBridge | < $10 |
| SES / SNS | < $5 |
| Anthropic API | **Variable — the main cost driver.** Sonnet 5.5 is $2 / $10 and Haiku 4.5 $1 / $5 per million input/output tokens; batches halve that; cache reads are much cheaper. Measure tokens per letter in M3 and set a budget alarm. |
| Web search (discovery) | $10 per 1,000 searches; at most 8 per letter ≈ up to $0.08, plus Sonnet tokens for reading the results (roughly $0.05–0.30 per letter before cache hits; measure in M3) |
| Bedrock embeddings | A few dollars at low volume |
| Transcripts (Supadata) | $0 on the free tier for personal use; $5/month plan if exceeded |

Prod adds Multi-AZ RDS (about 2× the DB cost) and swaps fck-nat for the managed NAT gateway (~$37+, or ~$74+ with one per AZ).

---

## 12. Decisions and open items

**Decided**

| Topic | Decision |
|---|---|
| Region / Claude provider | `ap-southeast-2` for AWS, one dev project for now; Claude through the Anthropic API directly; Bedrock only for embeddings |
| Mobile crash reporting | CloudWatch through `/client-logs` (JS errors only; see §8) |
| Content licensing | **Personal use:** full text retained and available offline by default. The rights gate stays in the code for later |
| Transcripts | Supadata (free tier), with TranscriptAPI.com or Apify as backup (§6.3) |
| Models | Sonnet 5.5 for writing, summaries, verification and search; Haiku 4.5 for enrichment and parsing |
| Discovery | Open web search with a growing publisher catalog and an exploration slot; no fixed publisher list (§6.3a). This replaces spec §6's "bounded set of editorially approved discovery sources" |
| Discovery budget and cache (M3) | Runs 3 h before each letter; at most 4 queries and 8 billed web searches per letter; results cached across users by normalized query for 7 days. Caps are constants in `packages/core` (§6.3a) |
| Publisher catalog rules (M3) | Deterministic, in `packages/core` (`publisherVerdict`, `userPublisherVerdict`): promotion on substantive or liked items; global blocks only for quality failures; votes block per user only (§6.3a) |
| Exploration slot (M3) | One per letter of 2+ pieces, from unproven discovered publishers, only for pieces that fit the user; transparent `discovered` / `exploration` / `publisher_record` pick signals (§6.3a) |
| Discovery data model (M3) | `discovery_run` per letter occurrence, every generated query in `discovery_query`, shared `discovery_search` cache, per-user `user_discovery` links and `user_publisher` blocks; method, model and prompt version on everything model-generated (§5) |
| Ingestion networking (M1) | Fetch and extract workers run **in the VPC with DB access** rather than outside it (§2). Dedupe (`ON CONFLICT` on canonical URL), source status and per-host politeness all need the DB, and routing them through extra queues isn't worth it at personal volume: fck-nat has no per-GB charge, and the managed NAT's $0.045/GB is cents here. Revisit if fetch volume grows. |
| Embeddings (M1) | Titan Text Embeddings v2 at 1024 dimensions (normalized), behind an `Embedder` interface so Cohere Embed can replace it |
| Short posts (M1) | Extraction only treats a page as a stub below 20 words; complete 30-word posts exist (found in the live exit check). Teasers are caught by paywall signals instead |

**Open**

| # | Item | Needed by |
|---|---|---|
| 1 | **Activity intensity rule:** whether an intentional `open` alone counts toward the grid or only complete/review (spec §9 says "deliberately read or reviewed") | M6 |
| 2 | **Default letter size and mix,** and short-letter vs skip default | M3 |
| 3 | **Imported newsletters** (deferred per spec §2; confirm) | Post-launch |
| 4 | **Risk:** transcript services rely on unofficial YouTube access and can break. Mitigation: swappable provider, backup ready, videos degrade to "saved, no skim" | Ongoing |
| 5 | **Risk:** open discovery surfaces low-quality or SEO content. Mitigation: quality label at enrichment, verification pass rate per publisher, blocked domains, user mute/block | M3 |
| 6 | **Risk:** generation quality on cheaper models. Mitigation: the eval set from M3 compares Sonnet/Haiku output against Opus 5.5 on the same articles; any task that falls short moves up a tier | M3 |
| 7 | **Risk:** SES production access delay. Production access is per region and the dev project is still in the sandbox in `ap-southeast-2`. Mitigation: request it in M0 | M0 |
