import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * HTTP client for user-supplied URLs (build plan §9, SSRF protection).
 *
 * - http(s) only, on every hop; redirects are followed by hand so each one is checked.
 * - Every address a hostname resolves to is checked against private, loopback,
 *   link-local (incl. 169.254.169.254) and other special ranges. The check runs
 *   inside the socket's DNS lookup, so the address that's checked is the one
 *   that's connected to (no DNS-rebinding window).
 * - Response size and total time are capped.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for addresses we must never connect to on a user's behalf. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true;
}

export type FetchFailure = "blocked_address" | "timeout" | "too_large" | "too_many_redirects" | "bad_url" | "network";

export class FetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FetchError";
  }
}

export interface FetchResult {
  status: number;
  /** The URL after redirects. */
  url: string;
  contentType: string;
  headers: Headers;
  body: string;
}

export interface FetchOptions {
  accept?: string;
  etag?: string | null;
  lastModified?: string | null;
}

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchResult>;

export interface SafeFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Tests only: allows fixture servers on 127.0.0.1. */
  allowPrivateNetworks?: boolean;
}

export const USER_AGENT = "FounderSignal/0.1 (personal reader; +https://github.com/ThinlySlicedShortRib/founder-signal)";

export function createSafeFetcher({
  timeoutMs = 15_000,
  maxBytes = 5 * 1024 * 1024,
  maxRedirects = 5,
  userAgent = USER_AGENT,
  allowPrivateNetworks = false,
}: SafeFetcherOptions = {}): Fetcher {
  const checkedLookup: typeof dnsLookup = ((hostname: string, options: object, callback: Function) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      const bad = allowPrivateNetworks ? undefined : addresses.find((a) => isBlockedAddress(a.address));
      if (bad) {
        return callback(new FetchError("blocked_address", `${hostname} resolves to a blocked address (${bad.address})`));
      }
      if ((options as { all?: boolean }).all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error(`No addresses for ${hostname}`));
      callback(null, first.address, first.family);
    });
  }) as typeof dnsLookup;

  const dispatcher = new Agent({ connect: { lookup: checkedLookup, timeout: timeoutMs } });

  return async function safeFetch(input, options = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = input;
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        let url: URL;
        try {
          url = new URL(current);
        } catch {
          throw new FetchError("bad_url", `Invalid URL: ${current}`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new FetchError("bad_url", `Refusing ${url.protocol} URL`);
        }
        // IP literals skip DNS, so check them here.
        const literal = url.hostname.replace(/^\[|\]$/g, "");
        if (!allowPrivateNetworks && isIP(literal) && isBlockedAddress(literal)) {
          throw new FetchError("blocked_address", `Refusing to fetch ${literal}`);
        }

        const headers: Record<string, string> = {
          "user-agent": userAgent,
          accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en;q=1, *;q=0.5",
        };
        if (hop === 0 && options.etag) headers["if-none-match"] = options.etag;
        if (hop === 0 && options.lastModified) headers["if-modified-since"] = options.lastModified;

        const res = await undiciFetch(url, { headers, redirect: "manual", signal, dispatcher });

        if (res.status >= 300 && res.status < 400 && res.status !== 304) {
          const location = res.headers.get("location");
          await res.body?.cancel();
          if (!location) throw new FetchError("network", `Redirect without a Location from ${url}`);
          current = new URL(location, url).toString();
          continue;
        }

        const body = await readCapped(res.body, maxBytes);
        const contentType = res.headers.get("content-type") ?? "";
        return {
          status: res.status,
          url: url.toString(),
          contentType,
          headers: res.headers as unknown as Headers,
          body: decode(body, contentType),
        };
      }
      throw new FetchError("too_many_redirects", `More than ${maxRedirects} redirects from ${input}`);
    } catch (err) {
      throw toFetchError(err, input);
    }
  };
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await stream.cancel().catch(() => {});
      throw new FetchError("too_large", `Response is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function toFetchError(err: unknown, url: string): FetchError {
  if (err instanceof FetchError) return err;
  // undici wraps connect-time errors (including our lookup's) in `cause`.
  let cause: unknown = err;
  for (let i = 0; i < 4 && cause; i++) {
    if (cause instanceof FetchError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  const name = (err as { name?: string }).name;
  if (name === "TimeoutError" || name === "AbortError") return new FetchError("timeout", `Timed out fetching ${url}`, { cause: err });
  return new FetchError("network", `Couldn't fetch ${url}: ${(err as Error).message}`, { cause: err });
}
