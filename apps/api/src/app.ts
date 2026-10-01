import { clientLogBatchSchema } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth.ts";
import type { ClientLogSink } from "./lib/client-log-sink.ts";
import { apiError } from "./lib/errors.ts";
import { createRateLimiter } from "./lib/rate-limit.ts";

type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type AppEnv = {
  Variables: {
    user: SessionData["user"] | null;
    session: SessionData["session"] | null;
  };
};

export interface AppDeps {
  auth: Auth;
  clientLogs: ClientLogSink;
}

export function createApp({ auth, clientLogs }: AppDeps) {
  const app = new Hono<AppEnv>();

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

  const requireUser = createMiddleware<AppEnv & { Variables: { user: SessionData["user"] } }>(async (c, next) => {
    if (!c.get("user")) return apiError(c, 401, "UNAUTHORIZED", "Sign in required");
    await next();
  });

  const clientLogLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

  const routes = app
    .get("/health", (c) => c.json({ ok: true as const }))

    .get("/me", requireUser, (c) => {
      const user = c.get("user");
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
    );

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
