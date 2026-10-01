/** Query parameters that only track the click and never change the content. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "ref",
  "ref_src",
  "ref_url",
  "si",
  "cmpid",
]);

/**
 * Normalizes a URL so the same page always gets the same key (build plan §6.3):
 * lowercases the host, drops default ports, fragments, tracking parameters and
 * trailing slashes, and sorts what's left of the query.
 */
export function canonicalizeUrl(input: string | URL): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  url.username = "";
  url.password = "";

  const kept = [...url.searchParams].filter(([key]) => {
    const k = key.toLowerCase();
    return !k.startsWith("utm_") && !TRACKING_PARAMS.has(k);
  });
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = new URLSearchParams(kept).toString();

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

/** The catalog key for a web publisher: its host without `www.`. */
export function publisherKeyForUrl(input: string | URL): string {
  return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
}

export function resolveUrl(href: string, base: string | URL): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"]);

export type YouTubeRef =
  | { kind: "video"; videoId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "handle"; handle: string }
  | { kind: "legacy"; name: string };

/** Recognizes YouTube video and channel URLs. Returns null for anything else. */
export function parseYouTubeUrl(input: string | URL): YouTubeRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname === "youtu.be") return parts[0] ? { kind: "video", videoId: parts[0] } : null;
  if (parts[0] === "watch") {
    const v = url.searchParams.get("v");
    return v ? { kind: "video", videoId: v } : null;
  }
  if ((parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") && parts[1]) {
    return { kind: "video", videoId: parts[1] };
  }
  if (parts[0] === "channel" && parts[1]) return { kind: "channel", channelId: parts[1] };
  if (parts[0]?.startsWith("@")) return { kind: "handle", handle: parts[0] };
  if ((parts[0] === "c" || parts[0] === "user") && parts[1]) return { kind: "legacy", name: parts[1] };
  return null;
}

export function youTubeVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
