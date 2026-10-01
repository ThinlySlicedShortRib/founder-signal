import { createDb } from "@fs/db";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import type { ClientLogRecord, ClientLogSink } from "../src/lib/client-log-sink.ts";
import type { EmailMessage, EmailSender } from "../src/lib/email.ts";

export const BASE_URL = "http://localhost:8787";

/** Builds the real app against the test database, with in-memory email and log sinks. */
export function createTestApp() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL not set (global setup didn't run)");
  const { db, pool } = createDb({ connectionString, ssl: false });

  const sentEmails: EmailMessage[] = [];
  const email: EmailSender = { async send(message) { sentEmails.push(message); } };
  const clientLogRecords: ClientLogRecord[] = [];
  const clientLogs: ClientLogSink = { async write(records) { clientLogRecords.push(...records); } };

  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: BASE_URL,
    email,
    allowDevOrigins: true,
  });
  const app = createApp({ auth, clientLogs });

  return { app, pool, sentEmails, clientLogRecords };
}

/** Signs in through the real email-OTP flow and returns the session cookie header. */
export async function signIn(ctx: ReturnType<typeof createTestApp>, email: string) {
  const headers = { "content-type": "application/json", origin: BASE_URL };

  const send = await ctx.app.request(`${BASE_URL}/api/auth/email-otp/send-verification-otp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  if (send.status !== 200) throw new Error(`send OTP failed: ${send.status} ${await send.text()}`);

  const message = ctx.sentEmails.findLast((m) => m.to === email);
  const otp = message?.subject.match(/(\d{6})/)?.[1];
  if (!otp) throw new Error("No OTP email captured");

  const res = await ctx.app.request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, otp }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);

  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}
