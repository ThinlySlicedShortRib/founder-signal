import type { RawMailStore } from "@fs/ingest";
import { clientLogBatchSchema } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Auth } from "./auth.ts";
import type { ClientLogSink } from "./lib/client-log-sink.ts";
import { apiError } from "./lib/errors.ts";
import { createRateLimiter } from "./lib/rate-limit.ts";
import { type AppEnv, requireUser } from "./lib/session.ts";
import { devRoutes, devToolRoutes, type OtpRecorder } from "./routes/dev.ts";
import { onboardingRoutes, preferenceRoutes, type ProfileRouteDeps } from "./routes/profile.ts";
import { itemRoutes, type LetterRouteDeps, letterRoutes, readingRoutes } from "./routes/letters.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { publisherRoutes } from "./routes/publishers.ts";
import { connectionRoutes, type ImportRouteDeps, importRoutes, youTubeCallbackRoutes } from "./routes/imports.ts";
import { newsletterRoutes } from "./routes/newsletters.ts";
import { type SourceRouteDeps, sourceRoutes } from "./routes/sources.ts";

export type { AppEnv };

export interface AppDeps
  extends SourceRouteDeps,
    ProfileRouteDeps,
    Omit<LetterRouteDeps, "detect">,
    Pick<ImportRouteDeps, "youtubeConnect" | "allowReturnTo"> {
  auth: Auth;
  clientLogs: ClientLogSink;
  /** Browser origins allowed to call the API with cookies (the Expo web dev server). Native apps don't need CORS. */
  corsOrigins?: string[];
  /** Set only for a local API: enables /dev (the sign-in shortcut and the Dev tools screen's routes). */
  devOtps?: OtpRecorder;
  /**
   * Newsletter forwarding: the inbound domain (null: off), and the raw-mail
   * store the local dev route writes to (null on AWS, where SES writes it).
   */
  newsletters?: { domain: string | null; mail: RawMailStore | null };
}

export function createApp({
  auth,
  clientLogs,
  db,
  detect,
  profileImporter,
  store,
  letterQueue,
  discoverQueue,
  discovery,
  reader,
  corsOrigins = [],
  devOtps,
  youtubeConnect,
  allowReturnTo,
  newsletters = { domain: null, mail: null },
}: AppDeps) {
  const app = new Hono<AppEnv>();

  if (corsOrigins.length) {
    app.use("*", cors({ origin: corsOrigins, credentials: true, allowHeaders: ["content-type"], maxAge: 600 }));
  }

  app.onError((err, c) => {
    console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack, path: c.req.path }));
    return apiError(c, 500, "INTERNAL", "Something went wrong");
  });
  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Not found"));

  if (devOtps) app.route("/dev", devRoutes({ auth, otps: devOtps, db }));

  // Better Auth owns everything under /api/auth (sign-in, sessions, sign-out).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Every other route sees the session (if any).
  app.use("*", async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", result?.user ?? null);
    c.set("session", result?.session ?? null);
    await next();
  });

  const clientLogLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
  // Local only, like /dev/sign-in-code. Elsewhere nothing is mounted; the empty router keeps the client's type.
  const devInbound = newsletters.domain && newsletters.mail ? { domain: newsletters.domain, mail: newsletters.mail } : null;
  const devTools = devOtps ? devToolRoutes({ db, inbound: devInbound }) : (new Hono() as ReturnType<typeof devToolRoutes>);
  // The first letter (onboarding) and test letters are made on demand, sometimes after a discovery run.
  const onDemand = { db, letterQueue, discoverQueue, discovery };

  const routes = app
    .get("/health", (c) => c.json({ ok: true as const }))

    .get("/me", requireUser, (c) => {
      const user = c.get("user")!;
      return c.json({ user: { id: user.id, email: user.email, name: user.name } });
    })

    // Error reports from the mobile app. Allowed before sign-in, because the
    // app can fail before a session exists; rate-limited per user or IP.
    .post(
      "/client-logs",
      bodyLimit({
        maxSize: 64 * 1024,
        onError: (c) => apiError(c, 413, "VALIDATION_FAILED", "Payload too large"),
      }),
      zValidator("json", clientLogBatchSchema, (result, c) => {
        if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Invalid log batch");
      }),
      async (c) => {
        const user = c.get("user");
        const key = user?.id ?? c.req.header("x-forwarded-for") ?? "anonymous";
        if (!clientLogLimiter(key)) return apiError(c, 429, "RATE_LIMITED", "Too many log reports");

        const receivedAt = new Date().toISOString();
        const { entries } = c.req.valid("json");
        await clientLogs.write(entries.map((entry) => ({ ...entry, userId: user?.id ?? null, receivedAt })));
        return c.json({ accepted: entries.length }, 202);
      },
    )

    .route("/me/sources", sourceRoutes({ db, detect }))
    .route("/me/imports", importRoutes({ db, detect, youtubeConnect }))
    .route("/me/newsletters", newsletterRoutes({ db, inboundDomain: newsletters.domain }))
    .route("/me/connections", connectionRoutes({ db, youtubeConnect, allowReturnTo }))
    // Google sends the browser here; the single-use state identifies the user.
    .route("/connections", youTubeCallbackRoutes({ db, youtubeConnect }))
    .route("/me/publishers", publisherRoutes({ db }))
    .route("/me", preferenceRoutes({ db }))
    .route("/me/onboarding", onboardingRoutes({ ...onDemand, profileImporter }))
    .route("/items", reviewRoutes({ db }))
    .route("/items", itemRoutes({ db, store, reader }))
    .route("/letters", letterRoutes({ db, reader }))
    .route("/", readingRoutes({ ...onDemand, detect }))
    .route("/dev", devTools);

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
