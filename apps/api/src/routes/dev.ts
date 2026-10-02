import { Hono } from "hono";
import type { Auth } from "../auth.ts";
import { apiError } from "../lib/errors.ts";

/** The account the app's "Skip sign-in (dev)" button uses. */
export const DEV_USER_EMAIL = "dev@founder-signal.local";

/** Remembers the latest code sent to each address (local development only). */
export function createOtpRecorder() {
  const latest = new Map<string, string>();
  return {
    record: (email: string, otp: string) => void latest.set(email.toLowerCase(), otp),
    take: (email: string) => {
      const otp = latest.get(email.toLowerCase());
      latest.delete(email.toLowerCase());
      return otp;
    },
  };
}

export type OtpRecorder = ReturnType<typeof createOtpRecorder>;

/**
 * Local development only, never mounted on AWS: sends a sign-in code for the
 * dev account and returns it, so the app can sign in through the normal
 * email-code flow without anyone reading the API log.
 */
export function devRoutes({ auth, otps }: { auth: Auth; otps: OtpRecorder }) {
  return new Hono().post("/sign-in-code", async (c) => {
    await auth.api.sendVerificationOTP({ body: { email: DEV_USER_EMAIL, type: "sign-in" } });
    const otp = otps.take(DEV_USER_EMAIL);
    if (!otp) return apiError(c, 500, "INTERNAL", "No code was generated");
    return c.json({ email: DEV_USER_EMAIL, otp });
  });
}
