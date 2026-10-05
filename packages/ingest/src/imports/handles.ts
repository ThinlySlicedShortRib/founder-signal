import { isIP } from "node:net";

/**
 * What people type for each platform, normalised. Each returns null when the
 * input can't be that platform's handle (the API answers with an example).
 */

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

function asUrl(raw: string): URL | null {
  if (!/^https?:\/\//i.test(raw) && !/^[\w.-]+\.[a-z]{2,}\//i.test(raw)) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** A public hostname: has a dot, no port, not an IP literal, not localhost-ish. */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  return DOMAIN.test(h) && !isIP(h) && !h.endsWith(".local") && !h.endsWith(".internal") && !h.endsWith(".localhost");
}

/** Substack: `@lenny`, `lenny`, `substack.com/@lenny`, or a publication's `lenny.substack.com`. */
export function parseSubstackHandle(raw: string): string | null {
  const input = raw.trim();
  const url = asUrl(input);
  let handle: string | undefined;
  if (url) {
    const host = url.hostname.toLowerCase();
    if (host === "substack.com" || host === "www.substack.com") {
      const first = url.pathname.split("/").filter(Boolean)[0];
      handle = first?.startsWith("@") ? first.slice(1) : undefined;
    } else if (host.endsWith(".substack.com")) {
      handle = host.slice(0, -".substack.com".length);
    }
  } else if (/^[\w-]+\.substack\.com$/i.test(input)) {
    handle = input.split(".")[0];
  } else {
    handle = input.replace(/^@/, "");
  }
  return handle && /^[a-z0-9_-]{1,64}$/i.test(handle) ? handle.toLowerCase() : null;
}

/**
 * Bluesky: `jay.bsky.team`, `@jay.bsky.team`, `bsky.app/profile/jay.bsky.team`,
 * a DID, or a bare name (taken as `name.bsky.social`).
 */
export function parseBlueskyHandle(raw: string): string | null {
  let input = raw.trim();
  const url = asUrl(input);
  if (url) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.toLowerCase() !== "bsky.app" || parts[0] !== "profile" || !parts[1]) return null;
    input = decodeURIComponent(parts[1]);
  }
  input = input.replace(/^@/, "");
  if (/^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/.test(input)) return input;
  const handle = input.toLowerCase();
  if (/^[a-z0-9-]{1,63}$/.test(handle)) return `${handle}.bsky.social`;
  return isPublicHostname(handle) ? handle : null;
}

/** Mastodon (and other fediverse servers): `@user@instance`, `user@instance`, `instance/@user`. */
export function parseMastodonHandle(raw: string): { user: string; host: string } | null {
  const input = raw.trim();
  const url = asUrl(input);
  let user: string | undefined;
  let host: string | undefined;
  if (url) {
    if (url.port || url.username) return null;
    host = url.hostname;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) user = parts[0].slice(1);
    else if (parts[0] === "users" && parts[1]) user = parts[1];
  } else {
    const m = input.match(/^@?([^@\s]+)@([^@\s/]+)$/);
    if (m) [, user, host] = m;
  }
  if (!user || !host) return null;
  // A handle copied from a remote profile (`@user@other` inside the URL).
  if (user.includes("@")) [user, host] = user.split("@") as [string, string];
  host = host.toLowerCase();
  if (!/^[a-z0-9_]([a-z0-9_.-]{0,62}[a-z0-9_])?$/i.test(user) || !isPublicHostname(host)) return null;
  return { user, host };
}
