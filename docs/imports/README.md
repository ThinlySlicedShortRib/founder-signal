# Import what I already follow

Sources → **Import what you follow** brings in the sources someone already
reads elsewhere. There are five ways in that end on the same checklist
("Add 23 of 41"), so nothing reaches the letters until it's picked, and a
sixth for newsletters that arrive by email ([Newsletters by
email](#newsletters-by-email)).

| Way in | How it works | Sign-in |
|---|---|---|
| **OPML file** | Upload the file (or paste its text). Exports from Feedly, Inoreader, Readwise Reader, NetNewsWire, Overcast, Apple Podcasts (Mac) and most readers work. | None |
| **YouTube** | Connect YouTube: Google consent for `youtube.readonly` only, then your subscriptions are read once. | Google, once |
| **Substack** | Your handle (`@name` or `substack.com/@name`). The publications your profile shows publicly. | None |
| **Bluesky** | Your handle (`name.bsky.social` or a custom domain). Everyone you follow, plus their websites' feeds. | None |
| **Mastodon** | Your full handle (`@name@server`). Everyone you follow, plus their websites' feeds. | None |
| **Newsletters (email)** | Your own forwarding address. Set a Gmail filter or Outlook rule to forward newsletters to it; each sender becomes a source as its first issue arrives. | None |

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

## Newsletters by email

For newsletters with no feed (or ones you'd rather read as they arrive),
each user gets a personal address, `n-<12 random base32 characters>@<inbound
domain>`, e.g. `n-k3j9q2m7xa4d@in.example.com`. A Gmail filter or Outlook
rule forwards newsletters to it; every issue becomes a piece in the pool,
eligible for letters like anything else followed. Sources → Import what you
follow → **Newsletters (email)** shows the address (Copy), the steps for
Gmail and Outlook, Gmail's confirmation code when it arrives, the senders
received so far (with piece counts and a Follow switch each), and **Get a new
address**.

### How it works

| Step | What happens |
|---|---|
| Address | `GET /me/newsletters` (or `/me/newsletters/address`) makes it on first use (`inbound_address`). 60 random bits, so it can't be guessed. `POST /me/newsletters/address/rotate` deactivates it and makes a new one (5 an hour); mail to an old address is refused. |
| Receiving | AWS: SES receives mail for the whole domain in `ap-southeast-2` (spam and virus scan on, TLS required), saves it to a private, KMS-encrypted bucket (`inbound/<SES message id>`) and publishes its notification to SNS → SQS → the `newsletter-inbound` worker. Locally: `POST /dev/newsletters/inbound` or the CLI (below). |
| Recording | One `inbound_message` row per stored message (unique raw key, so a redelivered notification is processed once), with the envelope recipient, sender, subject, SPF/DKIM/DMARC/spam/virus verdicts and the outcome. |
| Whose | The envelope recipient (SES's `receipt.recipients`); a Gmail filter keeps the newsletter's original To, so the headers are only a fallback (`X-Forwarded-To`, `Delivered-To`, `Received … for`, To, Cc). Unknown addresses are refused (`unknown_recipient`), rotated ones too (`inactive_address`). |
| Limits | 5 MB per message (`too_large`), 30 an hour and 200 a day per address (`rate_limited`). A virus verdict of FAIL drops the message unread (`virus`); a spam FAIL is kept but marked (`inbound_message.spam`). Attachments are never read. |
| Confirmation | Gmail's "Gmail Forwarding Confirmation" (from `forwarding-noreply@google.com`; the code in the subject and body, the link only on Google's own hosts) is stored on the message and shown in the app for 7 days ("Paste this code in Gmail", Copy code, Open the confirmation link), never treated as a newsletter. A Microsoft forwarding verification is recognized the same way, best effort (Outlook.com doesn't send one today). Anything that failed DKIM is never treated as a confirmation. |
| Sender | A filter forward arrives as sent: From is the newsletter. A manual forward ("Fwd:") is unwrapped best effort: the original From, Subject and Date from the forwarded header block (Gmail, Outlook, Apple Mail), and the quoted original's HTML (`.gmail_quote`, `#divRplyFwdMsg`, `blockquote[type=cite]`). |
| Source | One `newsletter` source per user and sender: key `newsletter:<userId>:list:<List-Id>` (else `…:from:<address>`), title from the List-Id phrase or the From name ("Jordan at Founder Ops Weekly" → "Founder Ops Weekly", author Jordan), never polled. Its publisher is keyed like its website, so it shares one with the RSS feed: the web version's host, else a Substack/Beehiiv List-Id host, else the sender's domain without mail subdomains (`email.morningbrew.com` → `morningbrew.com`); a sending platform's own domain with nothing else is `email:<address>`. The `user_source` points at a `source_import` (method `newsletter`, made with the address), so where it came from is kept. A sender you stop following (its Follow switch, i.e. the source's pause) has its later emails ignored (`not_following`). |
| Item | The canonical URL is the web version when the email links to it: `List-Post` if it's a web URL, a "View in browser"/"Read online" link, Substack's "View this post on the web at …", or a `/p/<slug>` post link around the title or repeated (Substack, Beehiiv). Tracked links are decoded only when the target is in the link itself (a `?url=` parameter, a base64 path segment); opaque redirects are never followed. Otherwise `newsletter://<hash of the Message-ID>`. Title: the subject without Fwd:/Re:; published: the Date header; author from the From name. |
| Text | The HTML (or the plain text) becomes blocks: layout tables are unwrapped into paragraphs (real data tables stay tables), hidden preheaders, tracking pixels, spacers, logos, share/like buttons and footer lines (unsubscribe, preferences, "view in browser", addresses, ©) are removed. Blocks only hold text and http(s) image URLs, so nothing executable survives. Under 20 words is `no_content`. |
| Dedupe | Same URL as a readable item (e.g. the post's RSS item), the same message forwarded twice, or a near-duplicate (SimHash) of a readable item: the email is linked to that item instead of making a new one. The candidate query counts items the user received by email (through `inbound_message`), so a newsletter linked to someone else's RSS item still reaches their letters. When the item at that URL isn't readable (pending, paywalled), the newsletter keeps its own copy under its `newsletter://` key. |
| Rights | Personal use: full text, retained, offline, like every source (rights rules still apply by domain or source key). New items are `extracted`, so enrichment picks them up on the next sweep. |

### Privacy

Forwarding a newsletter sends us its whole email, so only what's needed is
kept:

- The raw message is deleted as soon as it's processed (the bucket also
  expires anything left after 7 days, e.g. a message that failed).
- `inbound_message` keeps the sender's address, the subject, the verdicts and
  what it became; for a confirmation, the code, the Google/Microsoft link and
  the mailbox that asked. Bodies live on only as the item's blocks.
- Newsletter sources are per user, and their items never enter other users'
  shared pool: what arrives by email (possibly a paid post) stays with its
  reader.
- Only forward newsletters: anything sent to the address is processed as one.
  If it leaks, get a new address.

### Setting up the domain (you do this once, on AWS)

You need a domain or subdomain whose DNS you control; a subdomain such as
`in.example.com` keeps it apart from your normal mail. SES receives mail in
`ap-southeast-2` (the project's region), which supports email receiving.

1. In `infra/envs/dev/terraform.tfvars`, set `inbound_email_domain =
   "in.example.com"` and apply. This creates the SES domain identity (Easy
   DKIM), the receipt rule set (made active: a region has only one active
   rule set, so don't use another), the mail bucket (private, KMS, 7-day
   expiry, only SES may write under `inbound/` for this rule), the SNS topic,
   the `newsletter-inbound` queue, DLQ and worker, and passes
   `INBOUND_EMAIL_DOMAIN` to the API. Upload the `newsletter-inbound.zip`
   bundle with the others first.
2. `terraform output inbound_email_dns_records` lists the records to add at
   your DNS provider:
   - **MX** for `in.example.com`: `10 inbound-smtp.ap-southeast-2.amazonaws.com`
   - **3 CNAMEs** `<token>._domainkey.in.example.com` → `<token>.dkim.amazonses.com`
     (these verify the domain for SES).
3. Wait until the identity shows **Verified** in the SES console
   (`ap-southeast-2` → Identities), usually minutes, up to 72 hours.
4. Test: send a message to your address from the app; it should appear under
   "Received so far" within a minute. The worker's logs are in CloudWatch
   (`/aws/lambda/founder-signal-dev-newsletter-inbound`), failures land in the
   `newsletter-inbound` DLQ (alarmed).

Receiving doesn't depend on SES production access (that's for sending), but
check that SES is available on your plan if creating the rule fails.

### Gmail and Outlook

**Gmail** (on a computer):

1. Settings → See all settings → **Forwarding and POP/IMAP** → **Add a
   forwarding address**, paste your address.
2. Gmail sends a confirmation code to it. The app shows it within a minute
   (the screen polls): enter it in Gmail and choose **Verify**, or open the
   link.
3. Make a filter: open the search options, put the newsletter's address in
   **From** (several with `OR`), **Create filter** → **Forward it to** your
   address. "Skip the Inbox" is optional. Gmail's global forwarding switch can
   stay on "Disable forwarding"; the filter forwards only what it matches.

**Outlook** (outlook.com or Outlook on the web): Settings → Mail → **Rules**
→ Add new rule; condition **From** the newsletter, action **Forward to** your
address; save. No confirmation is sent. Microsoft 365 work and school
accounts often block forwarding outside the organisation (an admin policy).

You can also subscribe to a newsletter with the address directly.

### Local development

There's no SES locally. The domain defaults to `inbound.localhost`, and raw
messages wait in `apps/workers/.data/inbound` (`INBOUND_MAIL_DIR`) until the
dev runner processes them (within ~5 seconds):

```bash
# As the signed-in user (to their address, or ?to=<address>): the raw message as the body…
curl -b cookies -X POST localhost:8787/dev/newsletters/inbound \
  -H 'content-type: message/rfc822' --data-binary @packages/ingest/test/fixtures/newsletters/substack-post.eml
# …or an .eml upload (field "file"). Then see what happened:
curl -b cookies localhost:8787/dev/newsletters/inbound

# Or process one directly, without the API or the runner:
pnpm --filter @fs/workers newsletter packages/ingest/test/fixtures/newsletters/beehiiv-newsletter.eml --user sam@founder-signal.local
```

Fixtures (synthesised, not real newsletters) in
`packages/ingest/test/fixtures/newsletters/`: `substack-post.eml` (a Substack
post with a web version), `beehiiv-newsletter.eml` (a Beehiiv issue on a
custom sending domain, quoted-printable, only opaque tracked links, so a
`newsletter://` item) and `gmail-forwarding-confirmation.eml`.

### Limits

- Manual forwards are unwrapped best effort; a forward-as-attachment is read
  as its outer message. Filter forwarding is the reliable path.
- Footer and button removal is heuristic: an unusual footer line can survive
  as a short paragraph, and a short paragraph that looks like boilerplate can
  be dropped.
- A tracked "View in browser" link that can't be decoded without following it
  leaves the item on a `newsletter://` key, so it can't be deduped by URL with
  the post's RSS item (the SimHash check still catches identical text).
- A newsletter item with a web URL is a shared `content_item` like any other;
  if someone else's feed or discovery reaches the same URL they see that item
  (normally the public post).
- Outlook confirmations are recognized by sender domain and wording, which
  Microsoft could change.
