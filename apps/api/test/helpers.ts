import type { ProfileImporter } from "@fs/ai";
import { createDb } from "@fs/db";
import type { FetchResult, YouTubeClient } from "@fs/ingest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { createOtpRecorder } from "../src/routes/dev.ts";
import type { ClientLogRecord, ClientLogSink } from "../src/lib/client-log-sink.ts";
import type { EmailMessage, EmailSender } from "../src/lib/email.ts";

export const BASE_URL = "http://localhost:8787";

export interface FakePage {
  status?: number;
  contentType?: string;
  body: string;
}

/** Builds the real app against the test database, with in-memory email and log sinks and a fake web. */
export function createTestApp({
  corsOrigins,
  devSignIn = false,
  profileImporter = null,
}: { corsOrigins?: string[]; devSignIn?: boolean; profileImporter?: ProfileImporter | null } = {}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL not set (global setup didn't run)");
  const { db, pool } = createDb({ connectionString, ssl: false });

  const sentEmails: EmailMessage[] = [];
  const email: EmailSender = { async send(message) { sentEmails.push(message); } };
  const clientLogRecords: ClientLogRecord[] = [];
  const clientLogs: ClientLogSink = { async write(records) { clientLogRecords.push(...records); } };

  const devOtps = devSignIn ? createOtpRecorder() : undefined;
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: BASE_URL,
    email,
    allowDevOrigins: true,
    onOtp: devOtps?.record,
  });
  // URL → page. Tests add pages; anything else is a 404.
  const web = new Map<string, FakePage>();
  const fetch = async (url: string): Promise<FetchResult> => {
    const page = web.get(url);
    return {
      status: page ? (page.status ?? 200) : 404,
      url,
      contentType: page?.contentType ?? "text/html; charset=utf-8",
      headers: new Headers(),
      body: page?.body ?? "",
    };
  };
  const youtube: YouTubeClient = {
    async resolveChannel(ref) {
      return ref.kind === "handle" && ref.handle === "@founderstalk"
        ? { channelId: "UCfounders", title: "Founders Talk", uploadsPlaylistId: "UUfounders" }
        : null;
    },
    async listUploads() {
      return [];
    },
    async getVideo() {
      return null;
    },
  };

  const app = createApp({ auth, clientLogs, db, detect: { fetch, youtube }, profileImporter, corsOrigins, devOtps });

  return { app, db, pool, sentEmails, clientLogRecords, web };
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
