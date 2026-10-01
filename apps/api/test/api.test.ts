import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const ctx = createTestApp();
afterAll(() => ctx.pool.end());

const logEntry = {
  level: "error",
  message: "TypeError: undefined is not a function",
  stack: "at Today (app/(tabs)/index.tsx:12:3)",
  context: "/(tabs)",
  occurredAt: "2026-09-30T08:00:00.000Z",
  app: { version: "1.0.0", updateId: null, platform: "ios", osVersion: "26.0" },
};

describe("health", () => {
  it("responds", async () => {
    const res = await ctx.app.request(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("auth", () => {
  it("rejects /me without a session", async () => {
    const res = await ctx.app.request(`${BASE_URL}/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "UNAUTHORIZED", message: "Sign in required" });
  });

  it("signs in with an emailed code and returns the user", async () => {
    const cookie = await signIn(ctx, "reader@example.com");
    const res = await ctx.app.request(`${BASE_URL}/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe("reader@example.com");
  });

  it("rejects a wrong code", async () => {
    await ctx.app.request(`${BASE_URL}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email: "wrong@example.com", type: "sign-in" }),
    });
    const res = await ctx.app.request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email: "wrong@example.com", otp: "000000" }),
    });
    expect(res.status).not.toBe(200);
  });
});

describe("client logs", () => {
  it("accepts reports before sign-in", async () => {
    const res = await ctx.app.request(`${BASE_URL}/client-logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [logEntry] }),
    });
    expect(res.status).toBe(202);
    expect(ctx.clientLogRecords.at(-1)).toMatchObject({ message: logEntry.message, userId: null, fatal: false });
  });

  it("attaches the user when signed in", async () => {
    const cookie = await signIn(ctx, "logger@example.com");
    const res = await ctx.app.request(`${BASE_URL}/client-logs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ entries: [logEntry] }),
    });
    expect(res.status).toBe(202);
    expect(ctx.clientLogRecords.at(-1)?.userId).toEqual(expect.any(String));
  });

  it("rejects malformed batches", async () => {
    const res = await ctx.app.request(`${BASE_URL}/client-logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ level: "fatal" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rate-limits a runaway client", async () => {
    const send = () =>
      ctx.app.request(`${BASE_URL}/client-logs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ entries: [logEntry] }),
      });
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await send()).status);
    expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
