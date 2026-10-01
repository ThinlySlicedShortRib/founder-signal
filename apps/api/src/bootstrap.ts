import { type Env, resolveBetterAuthSecret, resolveDatabaseConfig } from "@fs/config";
import { createDb } from "@fs/db";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { cloudWatchClientLogSink, consoleClientLogSink } from "./lib/client-log-sink.ts";
import { consoleEmailSender, sesEmailSender } from "./lib/email.ts";

/** Wires real dependencies from the environment. Shared by the Lambda and local entry points. */
export async function buildApp(env: Env) {
  const [dbConfig, secret] = await Promise.all([resolveDatabaseConfig(env), resolveBetterAuthSecret(env)]);
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

  return createApp({ auth, clientLogs });
}
