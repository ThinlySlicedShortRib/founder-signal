/**
 * Authors: who wrote a piece, keyed stably across letters so the user can
 * follow them. A YouTube channel is its own author; a byline is scoped to the
 * publisher, so two writers who share a name on different sites don't merge.
 */

/** How long enriched details are trusted before they're checked again. */
export const AUTHOR_RECHECK_DAYS = 90;

/**
 * A usable person's name from a byline, or null: drops "By", handles,
 * links, extra co-authors and bylines that are really the site's name.
 */
export function cleanAuthorName(byline: string | null | undefined, publisherName?: string | null): string | null {
  if (!byline) return null;
  let name = byline
    .replace(/\s+/g, " ")
    .replace(/^\s*(by|written by|posted by|from)\s+/i, "")
    .split(/\s+(?:and|&)\s+|,\s*|\s+\|\s+|\s+·\s+/)[0]!
    .trim();
  name = name.replace(/^@/, "");
  if (!name || name.length > 60 || /https?:|www\.|\.(com|org|net|io)\b|@/i.test(name)) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (publisherName && name.toLowerCase() === publisherName.trim().toLowerCase()) return null;
  if (/^(admin|staff|editor|editors|team|guest|anonymous|unknown)$/i.test(name)) return null;
  return name;
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `youtube:<channelId>` for a video (the channel is the author), otherwise
 * `<publisher key>:<name slug>`, e.g. "priyaraman.com:priya-raman".
 */
export function authorKeyFor({ name, publisherKey }: { name: string; publisherKey: string }): string {
  if (publisherKey.startsWith("youtube:")) return publisherKey;
  return `${publisherKey}:${slugify(name) || "author"}`;
}

/** "Priya Raman" → "PR"; "Marc Andreessen Jr" → "MA"; "a16z" → "A". */
export function initialsFor(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((p) => p && !/^(jr|sr|ii|iii|phd|md)$/i.test(p));
  const letters = parts.length >= 2 ? [parts[0]!, parts[1]!] : parts.slice(0, 1);
  return letters.map((p) => p[0]!.toUpperCase()).join("").slice(0, 3) || "?";
}

/** "From priyaraman.com and Crunchbase, checked Oct 3". */
export function provenanceLine(sources: { name: string }[], checkedAt: Date): string | null {
  const names = [...new Set(sources.map((s) => s.name.trim()).filter(Boolean))];
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const when = checkedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `From ${list}, checked ${when}`;
}

/** Due for (re-)enrichment: never checked, or checked more than AUTHOR_RECHECK_DAYS ago. */
export function authorNeedsCheck(checkedAt: Date | null, now: Date): boolean {
  return !checkedAt || now.getTime() - checkedAt.getTime() > AUTHOR_RECHECK_DAYS * 86_400_000;
}
