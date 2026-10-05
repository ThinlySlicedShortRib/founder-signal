import type { ParsedEmail } from "./parse.ts";

/** A mail provider asking us to confirm that a mailbox may forward to our address. */
export interface ForwardingConfirmationRequest {
  provider: "gmail" | "outlook";
  /** Gmail's numeric confirmation code. */
  code: string | null;
  /** The provider's confirmation link: https, on one of its own hosts only. */
  url: string | null;
  /** The mailbox that wants to forward here. */
  requestedBy: string | null;
}

const GMAIL_SENDER = "forwarding-noreply@google.com";
const GMAIL_LINK_HOSTS = new Set(["mail-settings.google.com", "mail.google.com", "isolated.mail.google.com"]);

/** Microsoft's consumer and account domains. Outlook.com has no forwarding confirmation today; this catches one if it appears. */
const MICROSOFT_SENDER = /@((accountprotection\.|account\.|email\.)?microsoft\.com|outlook\.com|hotmail\.com|live\.com|office365\.com)$/i;
const MICROSOFT_LINK_HOST = /(^|\.)(live\.com|microsoft\.com|outlook\.com|office\.com|office365\.com|microsoftonline\.com)$/i;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

/**
 * Recognizes "confirm forwarding" messages, which must be shown to the user
 * rather than become a newsletter:
 * - Gmail: from forwarding-noreply@google.com, subject "(#123456789) Gmail
 *   Forwarding Confirmation - Receive Mail from you@gmail.com", with the code
 *   and a confirmation link in the body.
 * - Outlook/Microsoft 365, best effort: a message from a Microsoft domain
 *   about forwarding that asks to verify or confirm.
 * A message whose DKIM check failed is never treated as one (it would let
 * anyone put a link in front of the user).
 */
export function detectForwardingConfirmation(email: Pick<ParsedEmail, "from" | "subject" | "text" | "html">, verdicts: { dkim?: string } = {}): ForwardingConfirmationRequest | null {
  if (!email.from || verdicts.dkim === "FAIL") return null;
  const subject = email.subject ?? "";
  const body = email.text ?? stripTags(email.html ?? "");

  if (email.from.address === GMAIL_SENDER && /forwarding confirmation/i.test(subject)) {
    const code = subject.match(/\(#(\d{6,12})\)/)?.[1] ?? body.match(/confirmation code:?\s*(\d{6,12})/i)?.[1] ?? null;
    const requestedBy = subject.match(/receive mail from\s+(\S+@\S+)/i)?.[1] ?? body.match(new RegExp(`(${EMAIL.source}) has requested`, "i"))?.[1] ?? null;
    const url = linksIn(email).find((u) => GMAIL_LINK_HOSTS.has(u.hostname) && /\/vf-/.test(u.pathname))?.toString() ?? null;
    return { provider: "gmail", code, url, requestedBy: requestedBy?.toLowerCase() ?? null };
  }

  if (MICROSOFT_SENDER.test(email.from.address) && /forward/i.test(`${subject} ${body}`) && /(verif|confirm)/i.test(`${subject} ${body}`)) {
    const code = body.match(/code[^0-9]{0,40}(\d{4,10})/i)?.[1] ?? null;
    const url = linksIn(email).find((u) => MICROSOFT_LINK_HOST.test(u.hostname))?.toString() ?? null;
    if (!code && !url) return null;
    const requestedBy = body.match(EMAIL)?.[0]?.toLowerCase() ?? null;
    return { provider: "outlook", code, url, requestedBy };
  }
  return null;
}

/** Every https link in the message (hrefs in the HTML, bare URLs in the text). */
function linksIn(email: Pick<ParsedEmail, "text" | "html">): URL[] {
  const raw = [
    ...[...(email.html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]!)),
    ...[...(email.text ?? "").matchAll(/https:\/\/[^\s<>"')\]]+/g)].map((m) => m[0]),
  ];
  const out: URL[] = [];
  for (const href of raw) {
    try {
      const url = new URL(href);
      if (url.protocol === "https:") out.push(url);
    } catch {
      // Not a URL.
    }
  }
  return out;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
