import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp } from "./helpers.ts";

const enabled = createTestApp({ devSignIn: true });
const disabled = createTestApp();
afterAll(async () => {
  await enabled.pool.end();
  await disabled.pool.end();
});

describe("dev sign-in shortcut", () => {
  it("returns a working code for the dev account", async () => {
    const res = await enabled.app.request(`${BASE_URL}/dev/sign-in-code`, { method: "POST" });
    expect(res.status).toBe(200);
    const { email, otp } = (await res.json()) as { email: string; otp: string };
    expect(email).toBe("dev@founder-signal.local");
    expect(otp).toMatch(/^\d{6}$/);

    const signIn = await enabled.app.request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, otp }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const me = await enabled.app.request(`${BASE_URL}/me`, { headers: { cookie } });
    expect(await me.json()).toMatchObject({ user: { email: "dev@founder-signal.local" } });
  });

  it("doesn't exist unless the API is local", async () => {
    const res = await disabled.app.request(`${BASE_URL}/dev/sign-in-code`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
