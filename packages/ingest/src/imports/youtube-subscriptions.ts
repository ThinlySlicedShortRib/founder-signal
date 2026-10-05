import { z } from "zod";

/**
 * Connect YouTube (docs/imports/README.md): the Google OAuth 2.0 web-server
 * flow with PKCE, asking only for `youtube.readonly`, then the signed-in
 * user's subscriptions. Nothing is kept: no refresh token is asked for
 * (`access_type=online`) and the access token is revoked once the list is read.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must be registered on the OAuth client exactly (scheme, host, port, path). */
  redirectUrl: string;
}

export interface GoogleDeps {
  /** Injectable for tests; the real one is globalThis.fetch (fixed Google hosts, not user-supplied URLs). */
  fetch?: typeof globalThis.fetch;
  tokenUrl?: string;
  revokeUrl?: string;
  apiBaseUrl?: string;
}

/** The consent screen URL. `state` and the PKCE challenge come from the caller. */
export function googleAuthUrl(config: GoogleOAuthConfig, { state, codeChallenge }: { state: string; codeChallenge: string }): string {
  const qs = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    scope: YOUTUBE_READONLY_SCOPE,
    access_type: "online",
    include_granted_scopes: "false",
    prompt: "select_account",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_URL}?${qs}`;
}

const tokenSchema = z.object({ access_token: z.string(), scope: z.string().optional() });

export class GoogleOAuthError extends Error {
  readonly reason: "exchange_failed" | "scope_missing" | "api_failed";
  constructor(reason: GoogleOAuthError["reason"], message: string) {
    super(message);
    this.name = "GoogleOAuthError";
    this.reason = reason;
  }
}

/** Exchanges the authorization code (with the PKCE verifier) for a short-lived access token. */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  { fetch = globalThis.fetch, tokenUrl = GOOGLE_TOKEN_URL }: GoogleDeps = {},
): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = tokenSchema.safeParse(await res.json().catch(() => null));
  if (!res.ok || !parsed.success) throw new GoogleOAuthError("exchange_failed", `Google token exchange failed (${res.status})`);
  // The user can untick the scope on the consent screen.
  if (parsed.data.scope && !parsed.data.scope.split(" ").includes(YOUTUBE_READONLY_SCOPE)) {
    throw new GoogleOAuthError("scope_missing", "YouTube access wasn't granted");
  }
  return parsed.data.access_token;
}

/** Best effort: the token expires within the hour anyway. */
export async function revokeGoogleToken(token: string, { fetch = globalThis.fetch, revokeUrl = GOOGLE_REVOKE_URL }: GoogleDeps = {}) {
  try {
    await fetch(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Ignored.
  }
}

const subscriptionsSchema = z.object({
  nextPageToken: z.string().nullish(),
  items: z
    .array(
      z.object({
        snippet: z.object({
          title: z.string(),
          resourceId: z.object({ kind: z.string().optional(), channelId: z.string().optional() }),
        }),
      }),
    )
    .default([]),
});

export interface YouTubeSubscription {
  channelId: string;
  title: string;
}

/**
 * The signed-in user's subscriptions, 50 per page (1 quota unit each), at
 * most `maxPages` pages. `truncated` when there were more.
 */
export async function listYouTubeSubscriptions(
  accessToken: string,
  { fetch = globalThis.fetch, apiBaseUrl = "https://www.googleapis.com/youtube/v3", maxPages = 10 }: GoogleDeps & { maxPages?: number } = {},
): Promise<{ subscriptions: YouTubeSubscription[]; truncated: boolean }> {
  const subscriptions: YouTubeSubscription[] = [];
  let pageToken: string | null | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ part: "snippet", mine: "true", maxResults: "50", order: "alphabetical", ...(pageToken ? { pageToken } : {}) });
    const res = await fetch(`${apiBaseUrl}/subscriptions?${qs}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = subscriptionsSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success) throw new GoogleOAuthError("api_failed", `YouTube subscriptions ${res.status}`);
    for (const item of parsed.data.items) {
      const id = item.snippet.resourceId.channelId;
      if (id && /^UC[\w-]{22}$/.test(id)) subscriptions.push({ channelId: id, title: item.snippet.title });
    }
    pageToken = parsed.data.nextPageToken;
    if (!pageToken) return { subscriptions, truncated: false };
  }
  return { subscriptions, truncated: true };
}
