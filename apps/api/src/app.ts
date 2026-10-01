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
import { type SourceRouteDeps, sourceRoutes } from "./routes/sources.ts";

export type { AppEnv };

export interface AppDeps extends SourceRouteDeps {
  auth: Auth;
  clientLogs: ClientLogSink;
  /** Browser origins allowed to call the API with cookies (the Expo web dev server). Native apps don't need CORS. */
  corsOrigins?: string[];
}

export function createApp({ auth, clientLogs, db, detect, corsOrigins = [] }: AppDeps) {
  const app = new Hono<AppEnv>();

  if (corsOrigins.length) {
    app.use("*", cors({ origin: corsOrigins, credentials: true, allowHeaders: ["content-type"], maxAge: 600 }));
  }

  app.onError((err, c) => {
    console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack, path: c.req.path }));
    return apiError(c, 500, "INTERNAL", "Something went wrong");
  });
  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Not found"));

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

    .route("/me/sources", sourceRoutes({ db, detect }));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
