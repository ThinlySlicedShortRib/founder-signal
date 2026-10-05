import PostalMime, { addressParser, decodeWords, type Address, type Email } from "postal-mime";

/** A mailbox: the display name (decoded; null when there's none) and the lowercased address. */
export interface MailAddress {
  name: string | null;
  address: string;
}

/** SPF/DKIM/DMARC and spam/virus verdicts, as SES reports them: `PASS`, `FAIL`, `GRAY` or `PROCESSING_FAILED`. */
export interface MailVerdicts {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  spam?: string;
  virus?: string;
}

/** What the pipeline needs from a received email. Attachments are never read. */
export interface ParsedEmail {
  messageId: string | null;
  subject: string | null;
  date: Date | null;
  from: MailAddress | null;
  /** `List-Id`: the list's ID (lowercased, without the brackets) and its phrase. */
  listId: { id: string; name: string | null } | null;
  /** `List-Post`, when it's a web URL (some platforms put the post's page there). */
  listPost: string | null;
  html: string | null;
  text: string | null;
  /**
   * Addresses this copy was delivered to, from the headers, most specific
   * first: forwarding headers (`X-Forwarded-To`, `X-Original-To`,
   * `Delivered-To`), `Received: … for <x>`, then To and Cc. A filter-forwarded
   * newsletter keeps its original To (the user's own mailbox), so the envelope
   * recipient (from SES) is preferred whenever it's known.
   */
  recipients: string[];
  /** Verdicts from the headers SES adds (`X-SES-*-Verdict`, its `Authentication-Results`). */
  headerVerdicts: MailVerdicts;
  attachmentCount: number;
  /** First value of a header (lowercase name), unprocessed. */
  header(name: string): string | null;
}

export type InboundEmailErrorReason = "too_large" | "malformed";

export class InboundEmailError extends Error {
  readonly reason: InboundEmailErrorReason;
  constructor(reason: InboundEmailErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Parses a raw RFC 822 message with postal-mime (zero dependencies, MIT-0).
 * The size is checked before parsing; nesting and header size are bounded by
 * the parser. Throws InboundEmailError for oversized or unreadable input.
 */
export async function parseInboundEmail(raw: Uint8Array | string, { maxBytes }: { maxBytes: number }): Promise<ParsedEmail> {
  const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (size > maxBytes) throw new InboundEmailError("too_large", `The message is ${size} bytes (limit ${maxBytes})`);

  let email: Email;
  try {
    email = await PostalMime.parse(raw, {
      // Attachments are ignored; don't spend time decoding them.
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 32,
      maxHeadersSize: 256 * 1024,
      maxRfc822NestingDepth: 2,
    });
  } catch (err) {
    throw new InboundEmailError("malformed", `Unreadable message: ${(err as Error).message}`);
  }
  if (!email.headers.length || (!email.from && !email.html && !email.text)) {
    throw new InboundEmailError("malformed", "Not an email message (no headers, sender or body)");
  }

  const header = (name: string) => email.headers.find((h) => h.key === name)?.value ?? null;
  const date = email.date ? new Date(email.date) : null;

  return {
    messageId: email.messageId?.trim() || null,
    subject: cleanHeaderText(email.subject),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    from: mailbox(email.from),
    listId: parseListId(header("list-id")),
    listPost: parseListPost(header("list-post")),
    html: email.html?.trim() || null,
    text: email.text?.trim() || null,
    recipients: recipientsOf(email),
    headerVerdicts: headerVerdicts(email),
    attachmentCount: email.attachments.filter((a) => a.disposition === "attachment").length,
    header,
  };
}

function cleanHeaderText(value: string | undefined | null): string | null {
  return (value ?? "").replace(/\s+/g, " ").trim() || null;
}

export function mailbox(address: Address | undefined): MailAddress | null {
  const box = address?.group ? address.group[0] : address;
  if (!box?.address || !box.address.includes("@")) return null;
  return { name: cleanHeaderText(box.name), address: box.address.toLowerCase() };
}

/** `List-Id: Lenny's Newsletter <lenny.substack.com>` → `{ id: "lenny.substack.com", name: "Lenny's Newsletter" }`. */
export function parseListId(value: string | null): { id: string; name: string | null } | null {
  if (!value) return null;
  const match = value.match(/<([^<>\s]+)>/);
  const id = (match?.[1] ?? value).trim().toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(id) || id.length > 250) return null;
  const phrase = match ? value.slice(0, match.index).trim().replace(/^"|"$/g, "") : "";
  return { id, name: cleanHeaderText(decodeWords(phrase)) };
}

/** The first http(s) URL in `List-Post` (`NO` and mailto: lists don't count). */
function parseListPost(value: string | null): string | null {
  const url = value?.match(/<(https?:\/\/[^>\s]+)>/i)?.[1];
  return url ?? null;
}

const FORWARD_HEADERS = ["x-forwarded-to", "x-original-to", "delivered-to", "envelope-to", "x-envelope-to"];

function recipientsOf(email: Email): string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    for (const a of addressParser(value, { flatten: true })) if (a.address?.includes("@")) out.push(a.address.toLowerCase());
  };
  for (const name of FORWARD_HEADERS) for (const h of email.headers.filter((x) => x.key === name)) add(h.value);
  for (const h of email.headers.filter((x) => x.key === "received")) {
    const m = h.value.match(/\bfor\s+<?([^\s<>;]+@[^\s<>;]+)>?/i);
    if (m) out.push(m[1]!.toLowerCase());
  }
  for (const list of [email.to, email.cc]) for (const a of list ?? []) for (const m of a.group ?? [a]) if (m.address) out.push(m.address.toLowerCase());
  return [...new Set(out)];
}

const VERDICT = /^(PASS|FAIL|GRAY|PROCESSING_FAILED)$/i;

/**
 * SES puts its own headers on top, so only the first of each counts (a
 * sender can add look-alikes further down). Locally there are none.
 */
function headerVerdicts(email: Email): MailVerdicts {
  const out: MailVerdicts = {};
  const first = (name: string) => email.headers.find((h) => h.key === name)?.value.trim();
  const spam = first("x-ses-spam-verdict");
  const virus = first("x-ses-virus-verdict");
  if (spam && VERDICT.test(spam)) out.spam = spam.toUpperCase();
  if (virus && VERDICT.test(virus)) out.virus = virus.toUpperCase();
  const auth = email.headers.find((h) => h.key === "authentication-results");
  if (auth && /^\s*amazonses\.com\b/i.test(auth.value)) {
    for (const method of ["spf", "dkim", "dmarc"] as const) {
      const result = auth.value.match(new RegExp(`\\b${method}=(\\w+)`, "i"))?.[1]?.toLowerCase();
      if (result) out[method] = result === "pass" ? "PASS" : result === "fail" ? "FAIL" : "GRAY";
    }
  }
  return out;
}
