import { parseHTML } from "linkedom";
import { addressParser } from "postal-mime";
import type { MailAddress, ParsedEmail } from "./parse.ts";
import { mailbox } from "./parse.ts";

/** The original message inside a manual forward ("Fwd: …"). */
export interface UnwrappedForward {
  from: MailAddress | null;
  subject: string | null;
  date: Date | null;
  html: string | null;
  text: string | null;
}

/** Lines that start a forwarded message in Gmail, Apple Mail, Outlook and Thunderbird. */
const FORWARD_MARKER = /^\s*(?:-{3,}\s*(?:Forwarded message|Original Message)\s*-{3,}|Begin forwarded message:|_{10,}|-{3,}\s*Weitergeleitete Nachricht\s*-{3,}|-{3,} Message transféré -{3,})\s*$/im;
const HEADER_LINE = /^\s*\**(From|Date|Sent|Subject|To|Cc|Reply-To)\**\s*:\s*\**\s*(.*)$/i;

/**
 * Best effort: when someone forwards a newsletter by hand, the message is
 * from them, and the newsletter's From, Subject and Date are in a header
 * block in the body. Finds that block (in the text part) and the quoted
 * original (Gmail's `.gmail_quote`, Outlook's `#divRplyFwdMsg`, Apple's
 * `blockquote[type=cite]`). Null when the message isn't a forward or the
 * original sender can't be read; filter-forwarded mail arrives as-is and
 * never needs this.
 */
export function unwrapManualForward(email: Pick<ParsedEmail, "subject" | "text" | "html">): UnwrappedForward | null {
  if (!/^\s*(fwd?|fw|tr|wg)\s*:/i.test(email.subject ?? "")) return null;
  const text = email.text ?? (email.html ? parseHTML(`<!doctype html><html><body>${email.html}</body></html>`).document.body?.textContent ?? "" : "");
  const marker = FORWARD_MARKER.exec(text);
  if (!marker) return null;

  const lines = text.slice(marker.index + marker[0].length).replace(/\r\n?/g, "\n").split("\n");
  const headers = new Map<string, string>();
  let i = 0;
  // Skip blank lines before the block, then read header lines until the first blank line after them.
  while (i < lines.length && !lines[i]!.trim()) i++;
  for (; i < lines.length; i++) {
    const m = HEADER_LINE.exec(lines[i]!);
    if (!m) break;
    const key = m[1]!.toLowerCase() === "sent" ? "date" : m[1]!.toLowerCase();
    if (!headers.has(key)) headers.set(key, m[2]!.trim());
  }
  const fromValue = headers.get("from");
  if (!fromValue) return null;
  const parsed = addressParser(fromValue.replace(/\[mailto:[^\]]+\]/gi, ""));
  const from = mailbox(parsed[0]) ?? mailbox(addressParser(fromValue.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? "")[0]);
  if (!from) return null;

  return {
    from,
    subject: headers.get("subject")?.replace(/\s+/g, " ").trim() || null,
    date: parseLooseDate(headers.get("date")),
    html: email.html ? quotedOriginal(email.html) : null,
    text: lines.slice(i).join("\n").trim() || null,
  };
}

/** "Mon, Oct 5, 2026 at 9:02 AM", "5 October 2026 at 09:02:00 GMT+8", "Monday, October 5, 2026 9:02 AM". */
function parseLooseDate(value: string | undefined): Date | null {
  if (!value) return null;
  for (const candidate of [value, value.replace(/\s+at\s+/i, " "), value.replace(/^\w+,\s*/, "").replace(/\s+at\s+/i, " ")]) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** The quoted original's HTML, without the forward's own header lines. */
function quotedOriginal(html: string): string | null {
  const { document } = parseHTML(html.includes("<body") ? html : `<!doctype html><html><body>${html}</body></html>`);
  const gmail = document.querySelector(".gmail_quote");
  if (gmail) {
    for (const attr of [...gmail.querySelectorAll(".gmail_attr")]) attr.remove();
    return gmail.innerHTML;
  }
  const outlook = document.querySelector("#divRplyFwdMsg");
  if (outlook) {
    const parts: string[] = [];
    for (let n = outlook.nextElementSibling; n; n = n.nextElementSibling) parts.push(n.outerHTML);
    return parts.join("") || null;
  }
  const apple = document.querySelector("blockquote[type=cite]");
  if (apple) {
    // Apple puts the header lines in the quote's first divs.
    for (const div of [...apple.querySelectorAll("div")].slice(0, 8)) {
      if (HEADER_LINE.test(div.textContent ?? "") && (div.textContent ?? "").length < 300) div.remove();
    }
    return apple.innerHTML;
  }
  return null;
}
