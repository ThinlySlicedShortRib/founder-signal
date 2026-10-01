import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { expo } from "@better-auth/expo";
import type { Db } from "@fs/db";
import { schema } from "@fs/db";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import type { EmailSender } from "./lib/email.ts";

/** The app's URL scheme (apps/mobile/app.json → expo.scheme). */
export const APP_SCHEME = "foundersignal";

export interface CreateAuthOptions {
  db: Db;
  secret: string;
  /** Public base URL of this API. Optional: when unset, Better Auth infers it from the request. */
  baseURL?: string;
  email: EmailSender;
  /** Allows Expo Go / dev-client origins outside prod. */
  allowDevOrigins: boolean;
}

export function createAuth({ db, secret, baseURL, email, allowDevOrigins }: CreateAuthOptions) {
  return betterAuth({
    appName: "Founder Signal",
    secret,
    baseURL,
    basePath: "/api/auth",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    trustedOrigins: [
      `${APP_SCHEME}://`,
      ...(allowDevOrigins ? ["exp://", "exp://**", "exp://192.168.*.*:*/**"] : []),
    ],
    session: {
      // Lets most requests skip the session lookup in Postgres (build plan §7).
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: [
      expo(),
      // Passwordless sign-in: the app asks for a 6-digit code sent by email.
      // Apple and Google sign-in are added once their credentials exist.
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        // Awaited on purpose: an un-awaited send can be frozen mid-flight when Lambda suspends.
        async sendVerificationOTP({ email: to, otp }) {
          await email.send({
            to,
            subject: `Your Founder Signal code: ${otp}`,
            text: `Your sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
