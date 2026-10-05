# Import what I already follow

Sources → **Import what you follow** brings in the sources someone already
reads elsewhere. There are five ways in, and every one ends on the same
checklist ("Add 23 of 41"), so nothing reaches the letters until it's picked.

| Way in | How it works | Sign-in |
|---|---|---|
| **OPML file** | Upload the file (or paste its text). Exports from Feedly, Inoreader, Readwise Reader, NetNewsWire, Overcast, Apple Podcasts (Mac) and most readers work. | None |
| **YouTube** | Connect YouTube: Google consent for `youtube.readonly` only, then your subscriptions are read once. | Google, once |
| **Substack** | Your handle (`@name` or `substack.com/@name`). The publications your profile shows publicly. | None |
| **Bluesky** | Your handle (`name.bsky.social` or a custom domain). Everyone you follow, plus their websites' feeds. | None |
| **Mastodon** | Your full handle (`@name@server`). Everyone you follow, plus their websites' feeds. | None |

## How each platform maps to sources

| Found | Becomes | Publisher key |
|---|---|---|
| OPML `<outline xmlUrl>` | A `feed` source at that URL. Folders become the checklist's groups. | The `htmlUrl` host, else the feed's host |
| OPML outline with only `htmlUrl` | A website: its advertised feed if a quick look finds one; otherwise it stays a website and full detection (feed links, then common paths like `/feed`) runs when it's added | The site's host |
| OPML YouTube feed (`youtube.com/feeds/videos.xml?channel_id=UC…`) | A `youtube_channel` source | `youtube:<channelId>` |
| YouTube subscription | A `youtube_channel` source; its uploads playlist is the channel ID with `UC` → `UU` | `youtube:<channelId>` |
| Substack subscription | `https://<custom domain or subdomain.substack.com>/feed` | The publication's host |
| Bluesky follow | Their posts: `https://bsky.app/profile/<did>/rss` | `bsky:<did>` |
| Bluesky follow's website | A custom-domain handle (e.g. `pfrazee.com`), else the first link in their bio (its homepage). Offered only if its feed is found while listing | The site's host |
| Mastodon follow | Their public posts: `<profile URL>.rss` (Mastodon-style `/@user` profiles only) | `mastodon:<user@server>` |
| Mastodon follow's website | A verified profile link first, else any profile link (its homepage). Offered only if its feed is found while listing | The site's host |

Social websites come before accounts on the checklist: articles make better
letters than short posts.

## Behaviour

- **Listing** (`POST /me/imports/opml`, `POST /me/imports/handle`) returns the
  candidates and stores them with the import (`source_import`). Each has a
  stable key (the canonical feed URL, `youtube:<id>`, or `site:<url>`), a
  group, a second line, `check` (`ready`: the feed or channel is known;
  `site`: the feed is looked for when it's added) and `following` (already
  one of your sources; matched across `http`/`https` and with/without `www.`;
  a website counts as followed when you follow a feed from that site).
- **Repeats** within an import are dropped. At most **300** candidates are
  listed; the import's notes say how many were left out and why (over the
  cap, no feed found, hidden follows, servers without RSS).
- **Adding** (`POST /me/imports/:id/confirm` with `{keys, mode}`) adds only
  the picked keys that belong to that import, with one follow mode for the
  batch. Known feeds and channels are added straight away (the worker
  validates them on its first fetch; a broken feed shows its status on the
  Sources screen). Websites run full feed detection, four at a time, within
  18 seconds in all; the rest are reported as not checked in time and can be
  added again. Sources you already have are left exactly as they are (mode,
  pause). New sources are due immediately, so the next sweep fetches them.
  Confirm can run more than once per import.
- **Where each source came from** is kept: `user_source.import_id` points at
  the `source_import` row (method, label, counts, created and confirmed
  times). Deleting an import leaves the sources (`ON DELETE SET NULL`).
- The app's checklist ticks every new candidate, shows followed ones as
  "Following" (not tickable), has Select all/none, a search box for lists
  over 12, the follow-mode choice, and "Add N of M". `ImportOptions` and
  `ImportChecklist` (`apps/mobile/src/components/imports/`) have no screen
  chrome, so onboarding can reuse them later.

## Limits and safety

- OPML: 2 MB; DOCTYPEs are refused (no entity expansion, no external
  entities); at most 20,000 outlines and 32 levels are walked.
- Every fetch of a user-supplied URL (OPML sites, Mastodon servers, linked
  websites) and the fixed public APIs (Substack, Bluesky) goes through the
  SSRF-safe fetcher (`packages/ingest/src/safe-fetch.ts`). Mastodon handles
  must name a public hostname; pagination links are only followed on the
  same server and listing.
- Listing waits at most about 8 seconds for websites; follows are read up to
  about 500 per account. Handle imports are rate-limited per user (12 a
  minute, per API instance).
- Substack has no official API: the profile endpoint
  (`substack.com/api/v1/user/<handle>/public_profile`) is undocumented and
  can change. Failures say so and suggest an OPML export. Only subscriptions
  the profile shows publicly are listed.
- Mastodon servers or accounts can hide follows (401, or an empty list from
  someone who follows people): that's reported as private. Accounts on
  servers without `/@user.rss` (Pleroma, Pixelfed, Threads, bridges) are
  skipped and counted.
- Bluesky and Mastodon post feeds are short posts that link to app pages, so
  most of their items end up metadata-only (`too_short`) and rarely make a
  letter. The linked websites' feeds are the useful part; untick accounts you
  don't want.

## Connect YouTube

Separate from sign-in: it never creates an account or a session.

1. The app calls `POST /me/connections/youtube/start` with `{returnTo}` (the
   import screen's URL in this build: `foundersignal://sources/import`,
   `exp://…/--/sources/import` in Expo Go, `http://localhost:8081/sources/import`
   on the web). Only the app's scheme is allowed, plus Expo Go and the web
   dev server outside prod, so the callback can't be used as an open redirect.
2. The API makes a random `state` (stored only as its SHA-256 in
   `oauth_flow`, with the user, the PKCE verifier and `returnTo`; it expires
   after 10 minutes) and returns Google's consent URL: `youtube.readonly`,
   `access_type=online` (no refresh token), PKCE S256.
3. The app opens it (an auth session natively; the whole page on the web).
4. Google redirects to `GET /connections/youtube/callback`. The API deletes
   the flow row (single use, even if two callbacks race), exchanges the code
   with the verifier, reads the subscriptions (50 per page, 1 quota unit
   each, up to 500), **revokes the token** and stores nothing about the
   Google account. It saves the import for the user who started the flow and
   redirects to `returnTo?importId=…` (or `?importError=denied|expired|failed`).
5. The app opens the checklist.

### Setting up the Google OAuth client (you do this once)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project (e.g. "Founder Signal").
2. **APIs & Services → Library:** enable **YouTube Data API v3**.
3. **Google Auth Platform → Branding / Audience** (the OAuth consent screen):
   app name, your email as support and developer contact; user type
   **External**; leave the publishing status in **Testing** and add your own
   Google account under **Test users**. In Testing, only test users can
   connect and Google shows an "unverified app" notice, which is fine for
   personal use. **Data access:** add the scope
   `https://www.googleapis.com/auth/youtube.readonly`.
4. **Clients → Create client → Web application.** Authorized redirect URIs:
   - local: `http://localhost:8787/connections/youtube/callback`
   - AWS: `<your API URL>/connections/youtube/callback` (the `api_url`
     Terraform output, or your custom domain)
5. Copy the client ID and secret.
   - **Local:** in `.env`, set `GOOGLE_OAUTH_CLIENT_ID` and
     `GOOGLE_OAUTH_CLIENT_SECRET` (the redirect defaults to
     `BETTER_AUTH_URL` + `/connections/youtube/callback`; set
     `GOOGLE_OAUTH_REDIRECT_URL` to override). Restart the API.
   - **AWS:** set `google_oauth_client_id` in the env's `terraform.tfvars`,
     apply, then store the secret:
     `aws secretsmanager put-secret-value --secret-id founder-signal/<env>/google-oauth-client-secret --secret-string '<secret>'`.
     Only the API's role can read it.

Without a client ID and secret, `GET /me/imports` reports
`youtube.configured: false`, the app explains that Connect YouTube isn't set
up, and `start` answers `503 NOT_CONFIGURED`.

**Local development caveat:** Google only accepts `localhost` (or public
https) redirect URIs, never a private IP like `172.20.10.2`. So connect from
the **web build** (`http://localhost:8081`) or the iOS simulator; on a phone
in Expo Go the redirect to `localhost:8787` can't reach your Mac. Once
imported, the checklist and the new sources show up on every device. An
https tunnel to the API (registered as a redirect URI, with
`GOOGLE_OAUTH_REDIRECT_URL` set to it) also works.

Adding the channels also needs `YOUTUBE_API_KEY` (the worker lists uploads
with it); without one, YouTube sources show "YouTube isn't set up".

## Next

Newsletter forwarding (a personal address that turns forwarded or
subscribed email newsletters into a source) is the next step for
newsletters that have no feed; see the build plan, §12.
