import { publisherKeyForUrl } from "../url.ts";
import type { MailAddress } from "./parse.ts";

/** Who a newsletter is from, as a source and a publisher. */
export interface NewsletterSender {
  /** Stable per newsletter: `list:<List-Id>` when there is one, else `from:<address>`. */
  key: string;
  /** What the app shows under the name: the address (or the list). */
  label: string;
  /** The source's title: the newsletter's name. */
  title: string;
  /** The writer, when the From name says ("Lenny from Lenny's Newsletter"). */
  author: string | null;
  publisher: { key: string; name: string };
}

/** Sending platforms: their domain says nothing about the publication. */
const PLATFORM_DOMAINS =
  /(^|\.)(substack\.com|beehiiv\.com|mailchimp\.com|mcsv\.net|list-manage\.com|convertkit\.com|convertkit-mail\d*\.com|kit\.com|ghost\.io|buttondown\.email|buttondown\.com|mailerlite\.com|sendgrid\.net|mailgun\.org|amazonses\.com|sendinblue\.com|brevo\.com|createsend\.com|cmail\d*\.com|hubspotemail\.net|campaign-archive\.com|gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com)$/i;
/** Subdomains newsletters send from (`news@email.morningbrew.com` → morningbrew.com). */
const MAIL_LABELS = new Set(["mail", "email", "e", "em", "news", "newsletter", "newsletters", "m", "mg", "info", "hello", "send", "sends", "list", "lists", "updates", "mailer", "daily", "weekly"]);

/**
 * Maps a newsletter to its source and publisher. The publisher key is the
 * same one its website would get (its host without `www.`), so a newsletter
 * and its RSS feed share a publisher: the web version's host when known,
 * else a Substack/Beehiiv List-Id host, else the sender's domain without
 * mail subdomains. Mail from a sending platform's own domain with nothing
 * else to go on is keyed by its address (`email:<address>`).
 */
export function newsletterSender({
  from,
  listId,
  webUrl,
}: {
  from: MailAddress;
  listId: { id: string; name: string | null } | null;
  webUrl: string | null;
}): NewsletterSender {
  const byline = from.name?.match(/^(.+?)\s+(?:from|at|@)\s+(.+)$/i);
  const author = byline ? byline[1]!.trim() : null;
  const fromName = byline ? byline[2]!.trim() : from.name;

  let publisherKey: string;
  if (webUrl && /^https?:/i.test(webUrl)) publisherKey = publisherKeyForUrl(webUrl);
  else if (listId && /\.(substack|beehiiv)\.com$/.test(listId.id)) publisherKey = listId.id.replace(/^www\./, "");
  else {
    const domain = mailDomain(from.address);
    publisherKey = PLATFORM_DOMAINS.test(domain) ? `email:${from.address}` : domain;
  }

  const title = cleanName(listId?.name) ?? cleanName(fromName) ?? from.address;
  return {
    key: listId ? `list:${listId.id}` : `from:${from.address}`,
    label: from.address,
    title,
    author: author && author.toLowerCase() !== title.toLowerCase() ? author : null,
    publisher: { key: publisherKey, name: title },
  };
}

function mailDomain(address: string): string {
  const labels = address.slice(address.lastIndexOf("@") + 1).toLowerCase().split(".");
  while (labels.length > 2 && MAIL_LABELS.has(labels[0]!)) labels.shift();
  return labels.join(".");
}

function cleanName(value: string | null | undefined): string | null {
  const v = (value ?? "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  return v && !v.includes("@") ? v.slice(0, 200) : null;
}

/** A forwarded subject without its "Fwd:"/"Re:" prefixes. */
export function cleanSubject(subject: string | null): string | null {
  let s = (subject ?? "").replace(/\s+/g, " ").trim();
  while (/^(fwd?|fw|re|tr|wg)\s*:\s*/i.test(s)) s = s.replace(/^(fwd?|fw|re|tr|wg)\s*:\s*/i, "");
  return s.slice(0, 300) || null;
}
