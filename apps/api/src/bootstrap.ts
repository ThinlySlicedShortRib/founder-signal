import Anthropic from "@anthropic-ai/sdk";
import { anthropicProfileImporter, claudeCliProfileImporter, PROFILE_IMPORT_MODEL, PROFILE_IMPORT_PROMPT_VERSION, type ProfileImporter } from "@fs/ai";
import { type Env, resolveAnthropicApiKey, resolveBetterAuthSecret, resolveDatabaseConfig, resolveYouTubeApiKey } from "@fs/config";
import { createDb } from "@fs/db";
import { createSafeFetcher, youTubeDataClient } from "@fs/ingest";
import { createApp } from "./app.ts";
import { createAuth, DEV_WEB_ORIGINS } from "./auth.ts";
import { createOtpRecorder } from "./routes/dev.ts";
import { cloudWatchClientLogSink, consoleClientLogSink } from "./lib/client-log-sink.ts";
import { consoleEmailSender, sesEmailSender } from "./lib/email.ts";

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

  return createApp({ auth, clientLogs, db, detect, profileImporter: profileImporter(env), corsOrigins: env.APP_ENV === "prod" ? [] : DEV_WEB_ORIGINS, devOtps });
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
