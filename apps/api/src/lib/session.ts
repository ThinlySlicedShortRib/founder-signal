import { createMiddleware } from "hono/factory";
import type { Auth } from "../auth.ts";
import { apiError } from "./errors.ts";

type SessionData = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type SessionUser = SessionData["user"];

export type AppEnv = {
  Variables: {
    user: SessionUser | null;
    session: SessionData["session"] | null;
  };
};

/** Signed-in routes: `c.get("user")` is non-null after this. */
export type AuthedEnv = { Variables: { user: SessionUser; session: SessionData["session"] } };

export const requireUser = createMiddleware<AuthedEnv>(async (c, next) => {
  if (!c.get("user")) return apiError(c, 401, "UNAUTHORIZED", "Sign in required");
  await next();
});
