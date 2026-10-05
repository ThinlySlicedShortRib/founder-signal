import { createHash, randomBytes } from "node:crypto";
import { addImportedSource, type Db, type NewSource, schema, urlVariants } from "@fs/db";
import {
  dedupeFound,
  type DetectDeps,
  detectSource,
  exchangeGoogleCode,
  type FoundSource,
  foundYouTubeChannel,
  type GoogleDeps,
  googleAuthUrl,
  type GoogleOAuthConfig,
  ImportFailure,
  importBluesky,
  importMastodon,
  importSubstack,
  listYouTubeSubscriptions,
  OpmlError,
  parseBlueskyHandle,
  parseMastodonHandle,
  parseOpml,
  parseSubstackHandle,
  publisherKeyForUrl,
  revokeGoogleToken,
  settleSites,
  SourceDetectionError,
} from "@fs/ingest";
import {
  type ConfirmImportResult,
  confirmImportInputSchema,
  type ImportCandidate,
  importHandleInputSchema,
  type ImportMethod,
  importOpmlInputSchema,
  type ImportView,
  MAX_IMPORT_CANDIDATES,
  MAX_OPML_BYTES,
  youTubeConnectInputSchema,
} from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { oauthFlow, publisher, source, sourceImport, userSource } = schema;

/** Connect YouTube's settings; null when the Google OAuth client isn't configured. */
export interface YouTubeConnect {
  config: GoogleOAuthConfig;
  /** Fakes for tests; the real Google endpoints otherwise. */
  google?: GoogleDeps;
}

export interface ImportRouteDeps {
  db: Db;
  /** The SSRF-safe fetcher and YouTube client also used to add sources by hand. */
  detect: DetectDeps;
  youtubeConnect: YouTubeConnect | null;
  /** Where Connect YouTube may send the browser back to (the app's scheme; Expo Go and the web dev server outside prod). */
  allowReturnTo: (url: string) => boolean;
}

type StoredCandidate = FoundSource & { key: string };

const idParam = z.object({ id: z.uuid() });

/** A pending Connect YouTube expires after this long. */
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** While listing an import, websites get this long to show a feed link. */
const SITE_CHECK_MS = 8_000;
/** While adding, websites' feed detection gets this long in all (the API Gateway limit is 29 s). */
const CONFIRM_SITES_MS = 18_000;

/**
 * /me/imports (docs/imports/README.md): "import what I already follow".
 * Each import lists what it found as a checklist (stored with the import),
 * and confirm adds only the ones picked. Imports never add anything on
 * their own.
 */
export function importRoutes({ db, detect, youtubeConnect }: Omit<ImportRouteDeps, "allowReturnTo">) {
  // Handle imports call other services; this stops a runaway client, not a determined one.
  const limiter = createRateLimiter({ limit: 12, windowMs: 60_000 });

  return (
    new Hono<AuthedEnv>()
      .use(requireUser)

      .get("/", async (c) => {
        const rows = await db
          .select({
            id: sourceImport.id,
            method: sourceImport.method,
            label: sourceImport.label,
            createdAt: sourceImport.createdAt,
            foundCount: sourceImport.foundCount,
            addedCount: sourceImport.addedCount,
          })
          .from(sourceImport)
          .where(eq(sourceImport.userId, c.get("user").id))
          .orderBy(desc(sourceImport.createdAt))
          .limit(10);
        return c.json({
          youtube: { configured: !!youtubeConnect },
          imports: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        });
      })

      .post(
        "/opml",
        // JSON-escaped OPML can be a little larger than the file itself.
        bodyLimit({ maxSize: MAX_OPML_BYTES * 1.25, onError: (c) => apiError(c, 413, "VALIDATION_FAILED", "That file is over 2 MB") }),
        zValidator("json", importOpmlInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send the OPML file's text (up to 2 MB)");
        }),
        async (c) => {
          const userId = c.get("user").id;
          if (!limiter(userId)) return apiError(c, 429, "RATE_LIMITED", "Too many imports at once. Wait a minute.");
          const { opml, filename } = c.req.valid("json");
          let parsed;
          try {
            parsed = parseOpml(opml, { maxBytes: MAX_OPML_BYTES });
          } catch (err) {
            if (err instanceof OpmlError) return apiError(c, 422, "VALIDATION_FAILED", err.message);
            throw err;
          }
          const settled = await settleSites(parsed.found, detect.fetch, { deadlineMs: SITE_CHECK_MS });
          const notes: string[] = [];
          if (!parsed.found.length && !parsed.skipped) notes.push("That file has no feeds in it.");
          if (parsed.skipped) notes.push(plural(parsed.skipped, "entry had", "entries had") + " no link to follow.");
          const view = await createImport(db, {
            userId,
            method: "opml",
            label: filename || parsed.title || "OPML file",
            found: settled.found,
            notes,
          });
          return c.json({ import: view }, 201);
        },
      )

      .post(
        "/handle",
        zValidator("json", importHandleInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a platform and a handle");
        }),
        async (c) => {
          const userId = c.get("user").id;
          if (!limiter(userId)) return apiError(c, 429, "RATE_LIMITED", "Too many imports at once. Wait a minute.");
          const { platform, handle } = c.req.valid("json");

          let result;
          try {
            if (platform === "substack") {
              const h = parseSubstackHandle(handle);
              if (!h) return apiError(c, 400, "VALIDATION_FAILED", "Use your Substack handle, like @lenny or substack.com/@lenny");
              result = await importSubstack(h, detect.fetch);
            } else if (platform === "bluesky") {
              const h = parseBlueskyHandle(handle);
              if (!h) return apiError(c, 400, "VALIDATION_FAILED", "Use your Bluesky handle, like name.bsky.social");
              result = await importBluesky(h, detect.fetch);
            } else {
              const h = parseMastodonHandle(handle);
              if (!h) return apiError(c, 400, "VALIDATION_FAILED", "Use your full Mastodon handle, like @name@mastodon.social");
              result = await importMastodon(h, detect.fetch);
            }
          } catch (err) {
            if (err instanceof ImportFailure) {
              if (err.reason === "not_found") return apiError(c, 404, "NOT_FOUND", err.message);
              return apiError(c, err.reason === "invalid_handle" ? 400 : 422, err.reason === "invalid_handle" ? "VALIDATION_FAILED" : "SOURCE_UNAVAILABLE", err.message);
            }
            throw err;
          }

          // Linked websites are guesses: only the ones whose feed shows up in time are offered.
          const settled = await settleSites(result.found, detect.fetch, { deadlineMs: SITE_CHECK_MS, max: 150, concurrency: 12, strict: true });
          const notes = [...result.notes];
          if (settled.noFeed) notes.push(plural(settled.noFeed, "linked website has", "linked websites have") + " no feed we could find.");
          if (settled.unchecked) notes.push(plural(settled.unchecked, "linked website wasn't", "linked websites weren't") + " checked in time, so they're left out.");
          const view = await createImport(db, { userId, method: platform, label: result.label, found: settled.found, notes });
          return c.json({ import: view }, 201);
        },
      )

      .get(
        "/:id",
        zValidator("param", idParam, (result, c) => {
          if (!result.success) return apiError(c, 404, "NOT_FOUND", "Import not found");
        }),
        async (c) => {
          const view = await loadImportView(db, c.get("user").id, c.req.valid("param").id);
          if (!view) return apiError(c, 404, "NOT_FOUND", "Import not found");
          return c.json({ import: view });
        },
      )

      .post(
        "/:id/confirm",
        zValidator("param", idParam, (result, c) => {
          if (!result.success) return apiError(c, 404, "NOT_FOUND", "Import not found");
        }),
        zValidator("json", confirmImportInputSchema, (result, c) => {
          if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Pick at least one source to add");
        }),
        async (c) => {
          const userId = c.get("user").id;
          const { id } = c.req.valid("param");
          const { keys, mode } = c.req.valid("json");
          const [row] = await db.select().from(sourceImport).where(and(eq(sourceImport.id, id), eq(sourceImport.userId, userId)));
          if (!row) return apiError(c, 404, "NOT_FOUND", "Import not found");

          // Only what this import found can be added through it.
          const byKey = new Map((row.candidates as StoredCandidate[]).map((cand) => [cand.key, cand]));
          const picked = [...new Set(keys)].map((k) => byKey.get(k)).filter((cand): cand is StoredCandidate => !!cand);
          if (!picked.length) return apiError(c, 400, "VALIDATION_FAILED", "None of those are in this import");

          const result: ConfirmImportResult = { added: 0, alreadyFollowing: 0, failed: [] };
          const add = async (detected: NewSource) => {
            const { added } = await addImportedSource(db, { userId, mode, detected, importId: id });
            if (added) result.added++;
            else result.alreadyFollowing++;
          };

          for (const cand of picked.filter((p) => p.check === "ready")) await add(readySource(cand));

          // Websites without a known feed: full detection, a few at a time, within a budget.
          const sites = picked.filter((p) => p.check === "site");
          const deadline = Date.now() + CONFIRM_SITES_MS;
          await inParallel(sites, 4, async (cand) => {
            if (Date.now() > deadline) {
              result.failed.push({ key: cand.key, title: cand.title, message: "Not checked in time. Try adding it again." });
              return;
            }
            try {
              const detected = await withTimeout(detectSource(cand.url, detect), Math.max(1_000, deadline - Date.now()));
              if (detected.type !== "feed") {
                result.failed.push({ key: cand.key, title: cand.title, message: "No feed found on that site" });
                return;
              }
              await add({ ...detected, title: detected.title || cand.title });
            } catch (err) {
              const message = err instanceof SourceDetectionError ? err.message : err instanceof TimeoutError ? "That site took too long to answer" : null;
              if (message === null) throw err;
              result.failed.push({ key: cand.key, title: cand.title, message });
            }
          });

          await db
            .update(sourceImport)
            .set({ addedCount: sql`${sourceImport.addedCount} + ${result.added}`, confirmedAt: new Date() })
            .where(eq(sourceImport.id, id));
          return c.json(result);
        },
      )
  );
}

/**
 * Connect YouTube, step 1 (signed in): makes a single-use `state` bound to
 * this user, with a PKCE verifier kept server-side, and returns Google's
 * consent URL for the app to open.
 */
export function connectionRoutes({ db, youtubeConnect, allowReturnTo }: Omit<ImportRouteDeps, "detect">) {
  return new Hono<AuthedEnv>().use(requireUser).post(
    "/youtube/start",
    zValidator("json", youTubeConnectInputSchema, (result, c) => {
      if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send where to return to");
    }),
    async (c) => {
      if (!youtubeConnect) {
        return apiError(c, 503, "NOT_CONFIGURED", "Connect YouTube isn't set up on this server yet (it needs a Google OAuth client; see docs/imports/README.md).");
      }
      const { returnTo } = c.req.valid("json");
      if (!allowReturnTo(returnTo)) return apiError(c, 400, "VALIDATION_FAILED", "That return address isn't allowed");

      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(48).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      // Housekeeping: flows nobody finished.
      await db.delete(oauthFlow).where(lt(oauthFlow.expiresAt, new Date()));
      await db.insert(oauthFlow).values({
        stateHash: sha256(state),
        userId: c.get("user").id,
        provider: "youtube",
        codeVerifier,
        returnTo,
        expiresAt: new Date(Date.now() + OAUTH_FLOW_TTL_MS),
      });
      return c.json({ url: googleAuthUrl(youtubeConnect.config, { state, codeChallenge }) });
    },
  );
}

/**
 * Connect YouTube, step 2: Google sends the browser here (no session needed:
 * the state says whose flow it is, and works once). Reads the
 * subscriptions, stores them as an import, forgets the token, and sends the
 * browser back to the app with `importId` (or `importError`).
 */
export function youTubeCallbackRoutes({ db, youtubeConnect }: Pick<ImportRouteDeps, "db" | "youtubeConnect">) {
  return new Hono().get("/youtube/callback", async (c) => {
    if (!youtubeConnect) return c.text("Connect YouTube isn't set up on this server.", 404);
    const state = c.req.query("state");
    if (!state || state.length > 200) return c.text("Missing state. Go back to Founder Signal and try again.", 400);

    // Deleting it is what makes it single use, even with two callbacks racing.
    const [flow] = await db
      .delete(oauthFlow)
      .where(and(eq(oauthFlow.stateHash, sha256(state)), eq(oauthFlow.provider, "youtube")))
      .returning();
    if (!flow) return c.text("This link has expired or was already used. Go back to Founder Signal and try again.", 400);

    const back = (params: Record<string, string>) => {
      const url = new URL(flow.returnTo);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return c.redirect(url.toString(), 302);
    };
    if (flow.expiresAt.getTime() < Date.now()) return back({ importError: "expired" });
    const code = c.req.query("code");
    if (c.req.query("error") || !code) return back({ importError: "denied" });

    let subscriptions;
    let truncated;
    try {
      const token = await exchangeGoogleCode(youtubeConnect.config, { code, codeVerifier: flow.codeVerifier }, youtubeConnect.google);
      try {
        ({ subscriptions, truncated } = await listYouTubeSubscriptions(token, youtubeConnect.google));
      } finally {
        await revokeGoogleToken(token, youtubeConnect.google);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", message: "Connect YouTube failed", error: (err as Error).message }));
      return back({ importError: "failed" });
    }

    const notes: string[] = [];
    if (!subscriptions.length) notes.push("That YouTube account isn't subscribed to any channels.");
    if (truncated) notes.push(`Only the first ${subscriptions.length} subscriptions were read.`);
    const view = await createImport(db, {
      userId: flow.userId,
      method: "youtube",
      label: "Your YouTube subscriptions",
      found: subscriptions.map((s) => foundYouTubeChannel(s.channelId, s.title)),
      notes,
    });
    return back({ importId: view.id });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Stores a new import's checklist (deduped and capped) and returns its view. */
export async function createImport(
  db: Db,
  { userId, method, label, found, notes }: { userId: string; method: ImportMethod; label: string; found: FoundSource[]; notes: string[] },
): Promise<ImportView> {
  const { kept, overCap } = dedupeFound(found, MAX_IMPORT_CANDIDATES);
  const allNotes = overCap ? [...notes, `Only the first ${MAX_IMPORT_CANDIDATES} are listed; ${overCap} more were left out.`] : notes;
  const [row] = await db
    .insert(sourceImport)
    .values({ userId, method, label: label.slice(0, 200), candidates: kept, notes: allNotes, foundCount: kept.length })
    .returning({ id: sourceImport.id });
  return (await loadImportView(db, userId, row!.id))!;
}

async function loadImportView(db: Db, userId: string, id: string): Promise<ImportView | null> {
  const [row] = await db.select().from(sourceImport).where(and(eq(sourceImport.id, id), eq(sourceImport.userId, userId)));
  if (!row) return null;
  const following = await followedKeys(db, userId);
  const candidates: ImportCandidate[] = (row.candidates as StoredCandidate[]).map((cand) => ({
    key: cand.key,
    kind: cand.kind,
    title: cand.title,
    detail: cand.detail,
    group: cand.group,
    url: cand.url,
    check: cand.check,
    following: isFollowed(cand, following),
  }));
  return {
    id: row.id,
    method: row.method,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    candidates,
    notes: row.notes,
    addedCount: row.addedCount,
  };
}

/** The user's sources' keys, and their feeds' publishers (a website matches a feed you follow from it). */
async function followedKeys(db: Db, userId: string) {
  const rows = await db
    .select({ key: source.canonicalKey, type: source.type, publisherKey: publisher.key })
    .from(userSource)
    .innerJoin(source, eq(source.id, userSource.sourceId))
    .innerJoin(publisher, eq(publisher.id, source.publisherId))
    .where(eq(userSource.userId, userId));
  const keys = new Set<string>();
  for (const r of rows) for (const v of urlVariants(r.key)) keys.add(v);
  return { keys, feedPublishers: new Set(rows.filter((r) => r.type === "feed").map((r) => r.publisherKey)) };
}

function isFollowed(cand: StoredCandidate, followed: Awaited<ReturnType<typeof followedKeys>>): boolean {
  if (cand.check === "site") return followed.feedPublishers.has(publisherKeyForUrl(cand.url));
  return followed.keys.has(cand.key);
}

/** The source for a candidate whose feed or channel is known. The worker validates it on its first fetch. */
function readySource(cand: StoredCandidate): NewSource {
  if (cand.kind === "youtube_channel") {
    return {
      type: "youtube_channel",
      canonicalKey: cand.key,
      inputUrl: cand.url,
      // Every channel's uploads playlist is its ID with UC → UU.
      fetchUrl: `UU${cand.channelId!.slice(2)}`,
      title: cand.title,
      creator: cand.title,
      publisher: { ...cand.publisher, feedUrl: null },
    };
  }
  return {
    type: "feed",
    canonicalKey: cand.key,
    inputUrl: cand.url,
    fetchUrl: cand.url,
    title: cand.title,
    creator: null,
    publisher: { ...cand.publisher, feedUrl: cand.url },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimeoutError("timeout")), ms))),
  ]);
}

async function inParallel<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    }),
  );
}
