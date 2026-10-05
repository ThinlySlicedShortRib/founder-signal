import type { MailVerdicts } from "@fs/ingest";
import type { InboundDelivery } from "./receive.ts";

/**
 * SES's "Received" notification for its S3 action (published to SNS, then
 * delivered to SQS with raw message delivery). Only the fields we read.
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html
 */
interface SesReceivedNotification {
  notificationType?: string;
  mail?: { timestamp?: string; messageId?: string };
  receipt?: {
    recipients?: string[];
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string; objectKeyPrefix?: string };
  };
}

/**
 * Reads one SQS message body into a delivery: the raw message's S3 key, the
 * envelope recipients and SES's verdicts. Accepts the notification itself
 * (raw message delivery) or wrapped in an SNS envelope. Null for anything
 * else (SNS's subscription confirmation, a test message, another bucket),
 * which is acknowledged and dropped.
 */
export function deliveryFromSesMessage(body: string, { bucket, prefix = "inbound/" }: { bucket: string; prefix?: string }): InboundDelivery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  let note = parsed as SesReceivedNotification & { Type?: string; Message?: string };
  if (note.Type === "Notification" && typeof note.Message === "string") {
    try {
      note = JSON.parse(note.Message);
    } catch {
      return null;
    }
  }
  const action = note.receipt?.action;
  if (note.notificationType !== "Received" || action?.type !== "S3" || action.bucketName !== bucket || !action.objectKey) return null;
  // The notification's objectKey is SES's message ID; the object itself is under the rule's prefix.
  const keyPrefix = action.objectKeyPrefix ?? prefix;
  const rawKey = action.objectKey.startsWith(keyPrefix) ? action.objectKey : `${keyPrefix}${action.objectKey}`;
  if (!rawKey.startsWith(prefix)) return null;

  const verdict = (v?: { status?: string }) => (v?.status && /^(PASS|FAIL|GRAY|PROCESSING_FAILED)$/.test(v.status) ? v.status : undefined);
  const verdicts: MailVerdicts = {};
  for (const [name, v] of [
    ["spam", note.receipt?.spamVerdict],
    ["virus", note.receipt?.virusVerdict],
    ["spf", note.receipt?.spfVerdict],
    ["dkim", note.receipt?.dkimVerdict],
    ["dmarc", note.receipt?.dmarcVerdict],
  ] as const) {
    const s = verdict(v);
    if (s) verdicts[name] = s;
  }
  const at = note.mail?.timestamp ? new Date(note.mail.timestamp) : null;
  return {
    rawKey,
    envelopeTo: (note.receipt?.recipients ?? []).filter((r) => typeof r === "string").map((r) => r.toLowerCase()),
    verdicts,
    receivedAt: at && !Number.isNaN(at.getTime()) ? at : undefined,
  };
}
