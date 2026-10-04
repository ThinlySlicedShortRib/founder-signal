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
| `publisher` | `domain` unique (or channel ID for video); name, `feed_url` (autodetected), `status` (`candidate` / `trial` / `trusted` / `blocked`), `origin` (user_added / discovered), quality stats (items seen, extraction success rate, verification pass rate, interested/not-interested counts), `first_seen_at` | The growing publisher catalog (§6.3a). Shared across users; per-user preference lives in `user_source` and reviews. |
| `source` | `canonical_key` unique (feed URL / channel ID / domain); `publisher_id`, type, creator, `rights_rule_id`, `next_fetch_at`, `last_fetch_status` | Shared across users |
| `user_source` | `(user_id, source_id)` unique; mode (`more_like_this` / `follow_closely` / `occasional`), `blocked` | |
| `rights_rule` | scope (domain/source), `display` = `full_text` / `excerpt_only` / `link_only`, `retain_text` bool, `license_note`, `offline_allowed` | **Personal-use mode (current): default is `full_text`, retained, offline allowed.** The table stays so rules can be tightened if the app is ever shared. |
| `discovery_query` | `user_id`, query text, `goal_id`/topic it came from, `run_at`, results count, candidates accepted | Lets us see which queries find good material, and avoid repeating stale ones |
| `content_item` | `canonical_url` unique; type, creator, published_at, language, `embedding`, `quality_label`, `status` | Stable canonical ID reused across letters (§11) |
| `content_version` | `(item_id, content_hash)` unique; `fetched_at`, `blocks_s3_key` (null unless permitted), section map JSON, `rights_snapshot` | A new version is created when the content hash changes |
| `transcript` | `item_version_id`; `provider`, `provenance`, `confidence`, `s3_key` | No row → video can be saved but gets no skim |
| `letter` | `(user_id, occurrence_id)` **unique**; scheduled_for (UTC + local date), `status`, `step_attempts`, `generation_meta` (prompt/model versions), `why_this_mix` | The core duplicate-delivery guard |
| `letter_item` | `(letter_id, item_id)` unique; `(letter_id, feedback_code)` unique; `position`, **`snapshot` JSONB** (interesting line, personal line, actions, evidence refs, goal version), `pick_signals` JSONB | The snapshot preserves the historical copy (§5) |
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

### 6.3 Ingestion and rights (§6 steps 1–3, §7)
- **Adapters** in `packages/ingest`: RSS/Atom, single URL, sitemap/site, YouTube channel (via the Data API for listings), and **web-search discovery** (§6.3a). Each adapter declares its rate limit. The queue `maximum_concurrency` plus a per-domain `last_fetched_at` check enforce politeness.
- **Canonicalization:** resolve redirects, strip tracking params, respect `<link rel=canonical>`, normalize host and trailing slash. Near-duplicate detection uses a SimHash of the extracted text to collapse reposts and editions.
- **Extraction:** fetch → Readability (on a lightweight DOM) → sanitize → **block JSON** (`heading | paragraph | quote | list | image | caption | table`) with a section map. A Chromium-in-Lambda fallback handles JS-rendered pages.
- **Rights gate** (deterministic, in `packages/core`): the rule decides whether blocks are **retained** (S3) and **displayed**. **For personal use, every source defaults to full text, retained and available offline.** The gate and the digest mode are still built (they're cheap) so rules can be tightened later without a redesign. Paywalls and failures produce a metadata-only item with an explicit reason code; nothing is ever generated from a title alone.
- **Enrich (Claude via the Message Batches API at 50% off, plus embeddings):** enrichment isn't time-critical, so new items are batched every few minutes. Results normally arrive well within the hour; the API allows up to 24 h, so an item stays out of letters until it's enriched. It uses Haiku 4.5 to produce 2–4 topic tags, language, depth and read time, and a quality label (original and substantive vs. thin, rewritten or SEO filler), plus an embedding.
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
| `POST /me/schedule/test-letter`, `POST /me/schedule/skip-next` | |
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
| `GET /me/publishers`, `PATCH /me/publishers/:id` | See discovered publishers, then follow, mute or block them |

**Error model:** `{code, message}`, where `code` is one of `SOURCE_UNAVAILABLE | FULL_TEXT_UNLICENSED | TRANSCRIPT_MISSING | GENERATION_FAILED | NOT_FOUND | …`. `OFFLINE_CACHE_MISS` is generated on the client (§13).

---

## 8. Mobile app (Expo)

- **Navigation:** Expo Router tabs: Today · Library · Activity · Preferences. Stack routes for Reader, Feedback history, Onboarding, Source add, and "Why this was picked".
- **Onboarding:** stage → goals (presets + free text) → time budget and topics (seek/avoid) → sources (paste URL/RSS/YouTube, choose mode, optional loved/disliked examples) → schedule and channels → push permission (asked here, in context) → test letter.
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
| **M2** | Profile and onboarding | 4–6 | Onboarding flow, preferences/schedule API, goals and topics, `next_run_at` computation | A new user finishes onboarding in under 3 minutes |
| **M3** | Letter engine and discovery | 6–9 | Sweep, occurrence idempotency, collect/rank/generate/verify/lock, pick signals, test letter, eval set v1, **web-search discovery and publisher promotion (§6.3a)** | **Acceptance #1** (test letter with no operator work); duplicate-sweep chaos test yields exactly 1 letter |
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
| Web search (discovery) | $10 per 1,000 searches; ~5–10 per letter ≈ a few cents per letter |
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
