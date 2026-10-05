import { z } from "zod";
import { cleanText } from "../blocks.ts";
import { FetchError, type Fetcher } from "../safe-fetch.ts";
import { publisherKeyForUrl } from "../url.ts";
import { type FoundSource, foundFeed, foundSite, ImportFailure } from "./found.ts";
import { findSiteFeeds, isWebsiteLink, type SiteFeedOptions } from "./sites.ts";

/**
 * Imports from a public handle, no sign-in (docs/imports/README.md):
 * Substack (the publications a profile publicly subscribes to), Bluesky and
 * Mastodon (the accounts a profile follows, each as its RSS feed, plus their
 * websites' feeds when we can find them quickly). All requests go through
 * the SSRF-safe fetcher; a Mastodon instance is user-supplied.
 */

export interface HandleImport {
  /** How the import is labelled in the app, e.g. "@lenny on Substack". */
  label: string;
  found: FoundSource[];
  notes: string[];
}

export const PEOPLE_GROUP = "People you follow";
export const WEBSITES_GROUP = "Their websites";

/** Follows read at most per import (several pages); the checklist is capped separately. */
const MAX_FOLLOWS = 500;

async function getJson(fetch: Fetcher, url: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res;
  try {
    res = await fetch(url, { accept: "application/json" });
  } catch (err) {
    if (err instanceof FetchError && err.reason === "blocked_address") throw new ImportFailure("unavailable", "That address isn't allowed");
    throw new ImportFailure("unavailable", `${new URL(url).host} couldn't be reached. Try again in a minute.`);
  }
  let body: unknown = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

// ── Substack ────────────────────────────────────────────────────────────────

const substackProfileSchema = z.object({
  name: z.string().nullish(),
  handle: z.string().nullish(),
  subscriptions: z
    .array(
      z.object({
        publication: z.object({
          name: z.string(),
          subdomain: z.string(),
          custom_domain: z.string().nullish(),
          custom_domain_optional: z.boolean().nullish(),
          author: z.object({ name: z.string().nullish() }).nullish(),
        }),
      }),
    )
    .default([]),
  subscriptionsTruncated: z.boolean().nullish(),
});

/**
 * Substack has no official API. The profile page's own endpoint lists the
 * publications someone subscribes to, when they've left that public. It can
 * change without notice, so failures say so and point to the other imports.
 */
export async function importSubstack(handle: string, fetch: Fetcher, base = "https://substack.com"): Promise<HandleImport> {
  const { status, body } = await getJson(fetch, `${base}/api/v1/user/${encodeURIComponent(handle)}/public_profile`);
  if (status === 404) throw new ImportFailure("not_found", `There's no Substack profile @${handle}. Check the handle on your profile page (substack.com/@…).`);
  const parsed = substackProfileSchema.safeParse(body);
  if (status >= 400 || !parsed.success) {
    throw new ImportFailure(
      "unavailable",
      "Substack didn't answer the way we expected (it has no official API, so this can break). Try again later, or import an OPML file instead.",
    );
  }
  const profile = parsed.data;
  const found: FoundSource[] = [];
  for (const { publication: p } of profile.subscriptions) {
    const host = p.custom_domain && !p.custom_domain_optional ? p.custom_domain : `${p.subdomain}.substack.com`;
    if (!/^[a-z0-9.-]+$/i.test(host)) continue;
    const site = `https://${host}/`;
    const author = cleanText(p.author?.name) || null;
    const name = cleanText(p.name) || host;
    found.push(
      foundFeed(`https://${host}/feed`, {
        title: name,
        detail: [author !== name ? author : null, host.replace(/^www\./, "")].filter(Boolean).join(" · "),
        siteUrl: site,
        publisher: { key: publisherKeyForUrl(site), name },
      }),
    );
  }
  const notes: string[] = [];
  if (!found.length) notes.push(`@${handle} doesn't show any subscriptions publicly. On Substack, subscriptions are only visible when the profile lists them.`);
  if (profile.subscriptionsTruncated) notes.push("Substack only shows part of this profile's subscriptions.");
  return { label: `@${profile.handle ?? handle} on Substack`, found, notes };
}

// ── Bluesky ─────────────────────────────────────────────────────────────────

const blueskyFollowsSchema = z.object({
  subject: z.object({ handle: z.string() }).optional(),
  follows: z.array(z.object({ did: z.string(), handle: z.string(), displayName: z.string().nullish(), description: z.string().nullish() })),
  cursor: z.string().nullish(),
});

// Websites come first in both social imports: they're the better letter sources (articles rather
// than short posts), and the checklist's cap would otherwise cut them for anyone following hundreds.

/** Every follow's posts as its RSS feed (bsky.app/profile/<did>/rss); a custom-domain handle or a linked site as its website. */
export async function importBluesky(actor: string, fetch: Fetcher, base = "https://public.api.bsky.app"): Promise<HandleImport> {
  const people: FoundSource[] = [];
  const sites: FoundSource[] = [];
  let subject = actor;
  let cursor: string | null | undefined;
  let read = 0;
  do {
    const qs = new URLSearchParams({ actor, limit: "100", ...(cursor ? { cursor } : {}) });
    const { status, body } = await getJson(fetch, `${base}/xrpc/app.bsky.graph.getFollows?${qs}`);
    if (status === 400 && JSON.stringify(body ?? "").includes("not found")) {
      throw new ImportFailure("not_found", `There's no Bluesky account ${actor}. Use the full handle, like name.bsky.social.`);
    }
    const parsed = blueskyFollowsSchema.safeParse(body);
    if (status >= 400 || !parsed.success) throw new ImportFailure("unavailable", "Bluesky couldn't list that account's follows right now. Try again in a minute.");
    subject = parsed.data.subject?.handle ?? subject;
    for (const f of parsed.data.follows) {
      if (!/^did:[a-z]+:[\w.:%-]+$/.test(f.did)) continue;
      const name = cleanText(f.displayName) || f.handle;
      people.push(
        foundFeed(`https://bsky.app/profile/${f.did}/rss`, {
          title: name,
          detail: `@${f.handle} · Bluesky posts`,
          group: PEOPLE_GROUP,
          publisher: { key: `bsky:${f.did}`, name },
        }),
      );
      const site = blueskyWebsite(f.handle, f.description);
      if (site) sites.push(foundSite(site, { title: new URL(site).hostname.replace(/^www\./, ""), detail: `Website · ${name}`, group: WEBSITES_GROUP }));
    }
    read += parsed.data.follows.length;
    cursor = parsed.data.cursor;
  } while (cursor && read < MAX_FOLLOWS);

  const notes: string[] = [];
  if (!people.length) notes.push(`${subject} doesn't follow anyone yet.`);
  if (cursor) notes.push(`Only the first ${read} accounts ${subject} follows were read.`);
  return { label: `@${subject} on Bluesky`, found: [...sites, ...people], notes };
}

/** A custom-domain handle is usually the person's site; otherwise the first link in their bio. */
function blueskyWebsite(handle: string, description: string | null | undefined): string | null {
  const h = handle.toLowerCase();
  if (h !== "handle.invalid" && !h.endsWith(".bsky.social") && !h.endsWith(".bsky.team") && !h.endsWith(".brid.gy")) {
    const url = `https://${h}/`;
    if (isWebsiteLink(url)) return url;
  }
  for (const m of (description ?? "").matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    const url = homepage(m[0].replace(/[.,;:!?]+$/, ""));
    if (url && isWebsiteLink(url)) return url;
  }
  return null;
}

// ── Mastodon ────────────────────────────────────────────────────────────────

const mastodonAccountSchema = z.object({
  id: z.string(),
  username: z.string(),
  acct: z.string(),
  url: z.string().nullish(),
  display_name: z.string().nullish(),
  following_count: z.number().nullish(),
  fields: z.array(z.object({ name: z.string(), value: z.string(), verified_at: z.string().nullish() })).nullish(),
});

/** Accounts per page Mastodon allows. */
const MASTODON_PAGE = 80;

/**
 * Looks the account up on its own server, then reads who it follows (Link
 * header pagination, kept to the same server). Each follow's public posts are
 * its `<profile URL>.rss`; verified (or else any) profile links are offered
 * as websites. Servers and accounts can hide follows: that's a clear failure.
 */
export async function importMastodon({ user, host }: { user: string; host: string }, fetch: Fetcher): Promise<HandleImport> {
  const origin = `https://${host}`;
  const lookup = await getJson(fetch, `${origin}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`);
  if (lookup.status === 404) throw new ImportFailure("not_found", `There's no account @${user} on ${host}.`);
  const account = mastodonAccountSchema.safeParse(lookup.body);
  if (lookup.status >= 400 || !account.success) {
    throw new ImportFailure("unavailable", `${host} didn't answer like a Mastodon server. Check the handle (like @name@mastodon.social).`);
  }
  const handle = `@${account.data.username}@${host}`;
  const hidden = () => new ImportFailure("hidden", `${handle} keeps who they follow private, so it can't be imported. Try an OPML export instead.`);

  const people: FoundSource[] = [];
  const sites: FoundSource[] = [];
  let skipped = 0;
  let next: string | null = `${origin}/api/v1/accounts/${encodeURIComponent(account.data.id)}/following?limit=${MASTODON_PAGE}`;
  const pathPrefix = `/api/v1/accounts/${encodeURIComponent(account.data.id)}/following`;
  let read = 0;
  while (next && read < MAX_FOLLOWS) {
    const page = await getJson(fetch, next);
    if (page.status === 401 || page.status === 403) throw hidden();
    const list = z.array(mastodonAccountSchema).safeParse(page.body);
    if (page.status >= 400 || !list.success) throw new ImportFailure("unavailable", `${host} couldn't list who ${handle} follows right now. Try again in a minute.`);
    for (const a of list.data) {
      const acct = a.acct.includes("@") ? a.acct : `${a.acct}@${host}`;
      const name = cleanText(a.display_name) || a.username;
      const profile = a.url && /^https:\/\/[^/]+\/@[\w.-]+$/.test(a.url) && isWebsiteLink(a.url.replace(/\/@.*$/, "/")) ? a.url : null;
      if (profile) {
        people.push(foundFeed(`${profile}.rss`, { title: name, detail: `@${acct}`, group: PEOPLE_GROUP, publisher: { key: `mastodon:${acct.toLowerCase()}`, name } }));
      } else {
        skipped++;
      }
      const site = mastodonWebsite(a.fields ?? []);
      if (site) sites.push(foundSite(site, { title: new URL(site).hostname.replace(/^www\./, ""), detail: `Website · ${name}`, group: WEBSITES_GROUP }));
    }
    read += list.data.length;
    next = nextLink(page.headers.get("link"), host, pathPrefix);
  }

  // An empty list from someone who follows people means the server hides it.
  if (!read && (account.data.following_count ?? 0) > 0) throw hidden();
  const notes: string[] = [];
  if (!read) notes.push(`${handle} doesn't follow anyone yet.`);
  if (skipped) notes.push(`${skipped} account${skipped === 1 ? " is" : "s are"} on servers without a public RSS feed, so ${skipped === 1 ? "it was" : "they were"} left out.`);
  if (next) notes.push(`Only the first ${read} accounts ${handle} follows were read.`);
  return { label: `${handle}`, found: [...sites, ...people], notes };
}

/** The `rel="next"` URL of a Link header, only if it stays on the same server and listing. */
function nextLink(header: string | null, host: string, pathPrefix: string): string | null {
  for (const part of (header ?? "").split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (!m) continue;
    try {
      const url = new URL(m[1]!);
      return url.protocol === "https:" && url.hostname === host && url.pathname === pathPrefix ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mastodonWebsite(fields: { value: string; verified_at?: string | null }[]): string | null {
  const ordered = [...fields.filter((f) => f.verified_at), ...fields.filter((f) => !f.verified_at)];
  for (const f of ordered) {
    const href = homepage(f.value.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&"));
    if (href && isWebsiteLink(href)) return href;
  }
  return null;
}

/** A profile link's site: its homepage (a link to one book or one post isn't the person's site). */
function homepage(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return null;
  }
}

// ── Websites ────────────────────────────────────────────────────────────────

/**
 * Settles `site` entries quickly (findSiteFeeds): a site with an advertised
 * feed becomes that feed. The rest stay `site`s, whose feed is looked for
 * (common paths too) when they're added; with `strict` they're dropped
 * instead (social imports, where linked sites are guesses).
 */
export async function settleSites(
  found: FoundSource[],
  fetch: Fetcher,
  { strict = false, ...options }: SiteFeedOptions & { strict?: boolean } = {},
): Promise<{ found: FoundSource[]; noFeed: number; unchecked: number }> {
  const siteUrls = found.filter((f) => f.check === "site").map((f) => f.url);
  if (!siteUrls.length) return { found, noFeed: 0, unchecked: 0 };
  const feeds = await findSiteFeeds(siteUrls, fetch, options);
  let noFeed = 0;
  let unchecked = 0;
  const out: FoundSource[] = [];
  for (const f of found) {
    const feed = f.check === "site" ? feeds.get(f.url) : undefined;
    if (feed) out.push({ ...f, check: "ready", url: feed, publisher: { key: publisherKeyForUrl(f.url), name: f.publisher.name } });
    else if (f.check !== "site" || !strict) out.push(f);
    else if (feeds.has(f.url)) noFeed++;
    else unchecked++;
  }
  return { found: out, noFeed, unchecked };
}
