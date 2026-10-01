import { type Env, resolveBetterAuthSecret, resolveDatabaseConfig, resolveYouTubeApiKey } from "@fs/config";
import { createDb } from "@fs/db";
import { createSafeFetcher, youTubeDataClient } from "@fs/ingest";
import { createApp } from "./app.ts";
import { createAuth, DEV_WEB_ORIGINS } from "./auth.ts";
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

  const auth = createAuth({
    db,
    secret,
    baseURL: env.BETTER_AUTH_URL,
    email: env.EMAIL_TRANSPORT === "ses" ? sesEmailSender(env.EMAIL_FROM) : consoleEmailSender(),
    allowDevOrigins: env.APP_ENV !== "prod",
  });

  const clientLogs =
    env.CLIENT_LOG_SINK === "cloudwatch" ? cloudWatchClientLogSink(env.CLIENT_LOG_GROUP) : consoleClientLogSink();

  // Source validation fetches user-supplied URLs, so it uses the SSRF-safe client
  // with a short timeout (it runs inside an API request).
  const detect = {
    fetch: createSafeFetcher({ timeoutMs: 8_000, maxBytes: 3 * 1024 * 1024 }),
    youtube: youTubeKey ? youTubeDataClient({ apiKey: youTubeKey }) : null,
  };

  return createApp({ auth, clientLogs, db, detect, corsOrigins: env.APP_ENV === "prod" ? [] : DEV_WEB_ORIGINS });
}
