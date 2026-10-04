import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicProfileImporter,
  anthropicReaderWriter,
  claudeCliProfileImporter,
  claudeCliReaderWriter,
  PROFILE_IMPORT_MODEL,
  PROFILE_IMPORT_PROMPT_VERSION,
  type ProfileImporter,
  READER_MODEL,
  type ReaderWriter,
} from "@fs/ai";
import {
  discoveryMode,
  type Env,
  letterWriterMode,
  resolveAnthropicApiKey,
  resolveBetterAuthSecret,
  resolveContentDir,
  resolveDatabaseConfig,
  resolveYouTubeApiKey,
} from "@fs/config";
import { createDb } from "@fs/db";
import { createSafeFetcher, fsContentStore, s3ContentStore, youTubeDataClient } from "@fs/ingest";
import { createApp } from "./app.ts";
import { createAuth, DEV_WEB_ORIGINS } from "./auth.ts";
import { createOtpRecorder } from "./routes/dev.ts";
import { cloudWatchClientLogSink, consoleClientLogSink } from "./lib/client-log-sink.ts";
import { consoleEmailSender, sesEmailSender } from "./lib/email.ts";
import { sqsDiscoverQueue, sqsLetterQueue } from "./lib/letter-queue.ts";

/** Wires real dependencies from the environment. Shared by the Lambda and local entry points. */
export async function buildApp(env: Env) {
  const [dbConfig, secret, youTubeKey] = await Promise.all([
    resolveDatabaseConfig(env),
    resolveBetterAuthSecret(env),
    resolveYouTubeApiKey(env),
  ]);
  const { db } = createDb(dbConfig);

  // The dev sign-in shortcut exists only for an API on your machine that prints emails.
  const devOtps = env.APP_ENV === "local" && env.EMAIL_TRANSPORT === "console" ? createOtpRecorder() : undefined;

  const auth = createAuth({
    db,
    secret,
    baseURL: env.BETTER_AUTH_URL,
    email: env.EMAIL_TRANSPORT === "ses" ? sesEmailSender(env.EMAIL_FROM) : consoleEmailSender(),
    allowDevOrigins: env.APP_ENV !== "prod",
    onOtp: devOtps?.record,
  });

  const clientLogs =
    env.CLIENT_LOG_SINK === "cloudwatch" ? cloudWatchClientLogSink(env.CLIENT_LOG_GROUP) : consoleClientLogSink();

  // Source validation fetches user-supplied URLs, so it uses the SSRF-safe client
  // with a short timeout (it runs inside an API request).
  const detect = {
    fetch: createSafeFetcher({ timeoutMs: 8_000, maxBytes: 3 * 1024 * 1024 }),
    youtube: youTubeKey ? youTubeDataClient({ apiKey: youTubeKey }) : null,
  };

  return createApp({
    auth,
    clientLogs,
    db,
    detect,
    profileImporter: profileImporter(env),
    store: env.CONTENT_BUCKET ? s3ContentStore(env.CONTENT_BUCKET) : fsContentStore(resolveContentDir(env)),
    letterQueue: env.QUEUE_URL_LETTER_STEP ? sqsLetterQueue(env.QUEUE_URL_LETTER_STEP) : null,
    discoverQueue: env.QUEUE_URL_DISCOVER ? sqsDiscoverQueue(env.QUEUE_URL_DISCOVER) : null,
    // Same switch as the workers': with DISCOVERY=none, on-demand letters start straight away.
    discovery: discoveryMode(env) !== "none",
    reader: readerWriter(env),
    corsOrigins: env.APP_ENV === "prod" ? [] : DEV_WEB_ORIGINS,
    devOtps,
  });
}

/**
 * Section summaries and the P.S. recap (Haiku 4.5). Same switch as the
 * letter writer: the Claude Code CLI locally, the API on AWS, none with
 * LETTER_WRITER=none (then they're written from the text itself).
 */
function readerWriter(env: Env): ReaderWriter | null {
  const mode = letterWriterMode(env);
  if (mode === "claude-cli") return claudeCliReaderWriter({ command: env.CLAUDE_CLI_PATH });
  if (mode === "none" || (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY_SECRET_ARN)) return null;
  let inner: Promise<ReaderWriter> | undefined;
  const get = () => {
    inner ??= resolveAnthropicApiKey(env).then((apiKey) => anthropicReaderWriter(new Anthropic({ apiKey })));
    inner.catch(() => (inner = undefined));
    return inner;
  };
  return {
    method: "anthropic",
    model: READER_MODEL,
    summarizeSection: async (input) => (await get()).summarizeSection(input),
    forYou: async (input) => (await get()).forYou(input),
    recap: async (input) => (await get()).recap(input),
  };
}

/**
 * Onboarding's import reads the pasted note with Claude. Locally that's the
 * Claude Code CLI on your machine by default (PROFILE_IMPORTER=claude-cli), so
 * no API key is needed; set PROFILE_IMPORTER=anthropic to use the API instead.
 * Anywhere else it's the API, with the key resolved on first use so an unset
 * secret only degrades imports to the plain parser rather than failing the
 * API's cold start. Without either, the plain parser reads the note.
 */
function profileImporter(env: Env): ProfileImporter | null {
  if (env.APP_ENV === "local" && (env.PROFILE_IMPORTER ?? "claude-cli") === "claude-cli") {
    return claudeCliProfileImporter({ command: env.CLAUDE_CLI_PATH });
  }
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY_SECRET_ARN) return null;
  let inner: Promise<ProfileImporter> | undefined;
  return {
    method: "anthropic",
    model: PROFILE_IMPORT_MODEL,
    promptVersion: PROFILE_IMPORT_PROMPT_VERSION,
    async read(input) {
      inner ??= resolveAnthropicApiKey(env).then((apiKey) => anthropicProfileImporter(new Anthropic({ apiKey })));
      inner.catch(() => (inner = undefined));
      return (await inner).read(input);
    },
  };
}
