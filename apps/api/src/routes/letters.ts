import type { ReaderBrief, ReaderWriter } from "@fs/ai";
import { activityMonth, localDateOf, numbersIn, phraseMatches, resolvePieceIcon, splitChapters, stemSet } from "@fs/core";
import { addUserSource, type Db, schema } from "@fs/db";
import { blocksToText, type ContentStore, type DetectDeps, detectSource, type TranscriptSegment } from "@fs/ingest";
import {
  type ActivityMonth,
  type Block,
  eventsInputSchema,
  followAuthorInputSchema,
  type ItemView,
  leaningsInputSchema,
  type LetterSummary,
  type RightsDisplay,
  type SavedPiece,
  type Section,
  type SectionSummary,
  unavailableReasons,
  type UnavailableReason,
} from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { buildLetterView, latestDelivered, postscriptFor, storedRecap } from "../lib/letter-views.ts";
import { createOnDemandLetter, hasEnoughToPick, letterProgress, type OnDemandLetterDeps } from "../lib/on-demand-letter.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { author, contentItem, contentVersion, interaction, letter, letterItem, profile, publisher, review, schedule, summary, topicWeight, transcript, userAuthor } =
  schema;

export interface LetterRouteDeps extends OnDemandLetterDeps {
  db: Db;
  /** Where extracted blocks and transcripts are kept (S3 on AWS, a directory locally). */
  store: ContentStore;
  /** Section summaries and the P.S. recap; null writes them without a model. */
  reader: ReaderWriter | null;
  /** Following an author adds their feed or channel as a source. */
  detect: DetectDeps;
}

const idParam = z.object({ id: z.uuid() });
const PAGE_SIZE = 20;

const notFound = (what: string) => (r: { success: boolean }, c: Parameters<typeof apiError>[0]) => {
  if (!r.success) return apiError(c, 404, "NOT_FOUND", `${what} not found`);
};

async function ownLetter(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(letter)
    .where(and(eq(letter.id, id), eq(letter.userId, userId)));
  return row ?? null;
}

/** Cursor for /letters: the last letter's delivery time and ID. */
const encodeCursor = (deliveredAt: Date, id: string) => Buffer.from(`${deliveredAt.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const date = new Date(at ?? "");
  return id && z.uuid().safeParse(id).success && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

/** /letters: today's letter, past letters, one letter, and the P.S. choices. */
export function letterRoutes({ db, reader }: Pick<LetterRouteDeps, "db" | "reader">) {
  return new Hono<AuthedEnv>()
    .use(requireUser)

    .get("/today", async (c) => {
      const row = await latestDelivered(db, c.get("user").id);
      return c.json({ letter: row ? await buildLetterView(db, reader, row) : null });
    })

    .get(
      "/",
      zValidator("query", z.object({ cursor: z.string().max(200).optional() }), (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Invalid cursor");
      }),
      async (c) => {
      const userId = c.get("user").id;
      const { cursor } = c.req.valid("query");
      const after = cursor ? decodeCursor(cursor) : null;
      if (cursor && !after) return apiError(c, 400, "VALIDATION_FAILED", "Invalid cursor");

      const rows = await db
        .select({
          id: letter.id,
          number: letter.number,
          headline: letter.headline,
          localDate: letter.localDate,
          isTest: letter.isTest,
          deliveredAt: letter.deliveredAt,
          // Spelled out: Drizzle leaves columns unqualified in a single-table select, which a subquery would misread.
          pieceCount: sql<number>`(select count(*)::int from letter_item li where li.letter_id = "letter"."id")`,
          totalMinutes: sql<number>`(select coalesce(sum(greatest((li.snapshot->>'minutes')::int, 1)), 0)::int from letter_item li where li.letter_id = "letter"."id")`,
        })
        .from(letter)
        .where(
          and(
            eq(letter.userId, userId),
            isNotNull(letter.deliveredAt),
            ne(letter.status, "skipped"),
            after ? or(lt(letter.deliveredAt, after.at), and(eq(letter.deliveredAt, after.at), lt(letter.id, after.id))) : undefined,
          ),
        )
        .orderBy(desc(letter.deliveredAt), desc(letter.id))
        .limit(PAGE_SIZE + 1);

      const page = rows.slice(0, PAGE_SIZE);
      const letters: LetterSummary[] = page.map((r) => ({
        id: r.id,
        number: r.number ?? 1,
        headline: r.headline ?? "",
        localDate: r.localDate,
        totalMinutes: r.totalMinutes,
        isTest: r.isTest,
        pieceCount: r.pieceCount,
      }));
      const last = page.at(-1);
      const nextCursor = rows.length > PAGE_SIZE && last ? encodeCursor(last.deliveredAt!, last.id) : null;
      return c.json({ letters, nextCursor: nextCursor as string | null });
    })

    // Any of the user's letters, including one still being put together.
    .get("/:id", zValidator("param", idParam, notFound("Letter")), async (c) => {
      const row = await ownLetter(db, c.get("user").id, c.req.valid("param").id);
      if (!row) return apiError(c, 404, "NOT_FOUND", "Letter not found");
      return c.json({ letter: await buildLetterView(db, reader, row) });
    })

    // Where a letter being put together now has got to (Today polls the first letter and test letters here).
    .get("/:id/progress", zValidator("param", idParam, notFound("Letter")), async (c) => {
      const row = await ownLetter(db, c.get("user").id, c.req.valid("param").id);
      if (!row) return apiError(c, 404, "NOT_FOUND", "Letter not found");
      return c.json({ progress: await letterProgress(db, row) });
    })

    .put(
      "/:id/leanings",
      zValidator("param", idParam, notFound("Letter")),
      zValidator("json", leaningsInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send the chosen leanings");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { id } = c.req.valid("param");
        // Kept as the user wrote them; the next letter's rank step reads them as a one-off hint.
        const seen = new Set<string>();
        const chosen = c.req.valid("json").chosen.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
        const [row] = await db
          .update(letter)
          .set({ chosenLeanings: chosen })
          .where(and(eq(letter.id, id), eq(letter.userId, userId)))
          .returning();
        if (!row) return apiError(c, 404, "NOT_FOUND", "Letter not found");
        return c.json({ postscript: await postscriptFor(db, row, storedRecap(row)) });
      },
    );
}

// ── Items ───────────────────────────────────────────────────────────────────

interface RightsSnapshot {
  display: RightsDisplay;
  retainText: boolean;
  offlineAllowed: boolean;
  licenseNote?: string | null;
  storeBlocks?: boolean;
  unavailableReason?: string | null;
}

async function loadItem(db: Db, id: string) {
  const [row] = await db
    .select({
      item: contentItem,
      publisherName: publisher.name,
      versionId: contentVersion.id,
      blocksKey: contentVersion.blocksKey,
      sectionMap: contentVersion.sectionMap,
      rights: contentVersion.rightsSnapshot,
      excerpt: contentVersion.excerpt,
      transcriptKey: transcript.key,
    })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .leftJoin(
      contentVersion,
      eq(contentVersion.id, sql`(select id from ${contentVersion} where item_id = ${contentItem.id} order by fetched_at desc limit 1)`),
    )
    .leftJoin(transcript, eq(transcript.itemVersionId, contentVersion.id))
    .where(eq(contentItem.id, id));
  return row ?? null;
}
type LoadedItem = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

const NO_RIGHTS: RightsSnapshot = { display: "link_only", retainText: false, offlineAllowed: false, licenseNote: null };
const rightsOf = (row: LoadedItem) => (row.rights as RightsSnapshot | null) ?? NO_RIGHTS;
/** The text may be shown in full: the rule allows it and it was kept. */
const showsFullText = (row: LoadedItem) => rightsOf(row).display === "full_text" && rightsOf(row).retainText;

function minutesOf(item: LoadedItem["item"]): number | null {
  if (item.type === "video" && item.durationSeconds) return Math.max(1, Math.round(item.durationSeconds / 60));
  return item.readTimeMinutes;
}

async function loadSegments(store: ContentStore, key: string | null) {
  if (!key) return null;
  return (await store.getJson<{ segments: TranscriptSegment[] }>(key))?.segments ?? null;
}

/**
 * The reader's view (rights-aware): full text as blocks when the rule allows
 * it, a digest otherwise; for a video, its ID, duration and transcript chapters.
 */
async function itemView(store: ContentStore, row: LoadedItem): Promise<ItemView> {
  const r = rightsOf(row);
  const fullText = showsFullText(row);
  const reason = (unavailableReasons as readonly string[]).includes(row.item.statusReason ?? "") ? (row.item.statusReason as UnavailableReason) : null;
  const base = {
    id: row.item.id,
    kind: row.item.type,
    title: row.item.title ?? row.item.canonicalUrl,
    sourceName: row.publisherName,
    originalUrl: row.item.canonicalUrl,
    minutes: minutesOf(row.item),
    rights: { display: r.display, retainText: r.retainText, offlineAllowed: r.offlineAllowed, licenseNote: r.licenseNote ?? null },
    unavailableReason: reason,
  };

  if (row.item.type === "video") {
    const segments = fullText ? await loadSegments(store, row.transcriptKey) : null;
    return {
      ...base,
      blocks: null,
      sections: [],
      digest: fullText ? null : row.excerpt,
      video: {
        youtubeId: row.item.externalId!,
        durationSeconds: row.item.durationSeconds,
        chapters: segments ? splitChapters(segments) : null,
      },
    };
  }

  const stored = fullText && row.blocksKey ? await store.getJson<{ blocks: Block[]; sections: Section[] }>(row.blocksKey) : null;
  return {
    ...base,
    blocks: stored?.blocks ?? null,
    sections: stored ? (stored.sections ?? (row.sectionMap as Section[])) : [],
    digest: stored ? null : row.excerpt,
    video: null,
  };
}

/** The text of one section (articles) or chapter `c<n>` (videos), when the rights allow reading it. */
async function sectionText(store: ContentStore, row: LoadedItem, sectionId: string): Promise<{ title: string | null; text: string } | null> {
  if (!showsFullText(row)) return null;
  if (row.item.type === "video") {
    const n = Number(sectionId.match(/^c(\d+)$/)?.[1]);
    const segments = await loadSegments(store, row.transcriptKey);
    const chapter = segments && n ? splitChapters(segments)[n - 1] : undefined;
    return chapter ? { title: chapter.title, text: chapter.text } : null;
  }
  const stored = row.blocksKey ? await store.getJson<{ blocks: Block[]; sections: Section[] }>(row.blocksKey) : null;
  const section = (stored?.sections ?? (row.sectionMap as Section[])).find((s) => s.id === sectionId);
  if (!stored || !section) return null;
  return { title: section.title, text: blocksToText(stored.blocks.slice(section.startBlock, section.endBlock)) };
}

async function readerBrief(db: Db, userId: string): Promise<ReaderBrief> {
  const [[p], topics] = await Promise.all([
    db.select({ role: profile.role, lately: profile.lately }).from(profile).where(eq(profile.userId, userId)),
    db.select({ topic: topicWeight.topic }).from(topicWeight).where(and(eq(topicWeight.userId, userId), eq(topicWeight.origin, "explicit"))),
  ]);
  return { role: p?.role ?? null, lately: p?.lately ?? null, topics: topics.map((t) => t.topic) };
}

const sentences = (text: string) => text.match(/[^.!?…]+[.!?…]+["”’)]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text.trim()];

/** Claim and evidence without a model: the section's own opening sentences. */
function plainSummary(text: string): { claim: string; evidence: string } {
  const s = sentences(text);
  return { claim: s[0]?.slice(0, 300) ?? "", evidence: s.slice(1, 3).join(" ").slice(0, 400) || (s[0]?.slice(0, 300) ?? "") };
}

/** "For you" without a model: the user's topic the section is about, if any. */
function plainForYou(text: string, brief: ReaderBrief): string {
  const stems = stemSet(text);
  const topic = brief.topics.find((t) => phraseMatches(t, stems));
  if (topic) return `This section is about ${topic.toLowerCase()}, one of your topics.`;
  if (brief.lately && phraseMatches(brief.lately, stems)) return `It touches on what you said you're into lately: “${brief.lately}”.`;
  return "Worth a look if it connects to what you're working on.";
}

/** The model's numbers must come from the section (§6.5); otherwise its summary isn't used. */
const supported = (out: string, text: string) => {
  const have = new Set(numbersIn(text));
  return numbersIn(out).every((n) => have.has(n));
};

/** /items/:id (the reader) and /items/:id/summary. Reviews live in reviews.ts on the same prefix. */
export function itemRoutes({ db, store, reader }: Pick<LetterRouteDeps, "db" | "store" | "reader">) {
  // Each uncached summary is a model call; this keeps a stuck client from running up a bill.
  const summaryLimiter = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

  return new Hono<AuthedEnv>()
    .use(requireUser)
    .get("/:id", zValidator("param", idParam, notFound("Item")), async (c) => {
      const row = await loadItem(db, c.req.valid("param").id);
      if (!row) return apiError(c, 404, "NOT_FOUND", "Item not found");
      return c.json({ item: await itemView(store, row) });
    })
    .post(
      "/:id/summary",
      zValidator("param", idParam, notFound("Item")),
      zValidator("json", z.object({ sectionId: z.string().min(1).max(40) }), (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a sectionId");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { sectionId } = c.req.valid("json");
        const row = await loadItem(db, c.req.valid("param").id);
        if (!row || !row.versionId) return apiError(c, 404, "NOT_FOUND", "Item not found");
        if (!showsFullText(row)) return apiError(c, 422, "FULL_TEXT_UNLICENSED", "This piece can't be summarized here");
        const section = await sectionText(store, row, sectionId);
        if (!section || !section.text.trim()) return apiError(c, 404, "NOT_FOUND", "Section not found");

        const brief = await readerBrief(db, userId);
        const title = row.item.title ?? "";
        const useModel = reader && summaryLimiter(userId);
        const [cached] = await db
          .select()
          .from(summary)
          .where(and(eq(summary.itemVersionId, row.versionId), eq(summary.sectionId, sectionId)));

        let claim = cached?.claim;
        let evidence = cached?.evidence;
        let forYou: string | null = null;
        if (!cached && useModel) {
          try {
            const out = await reader.summarizeSection({ title, sectionTitle: section.title, text: section.text, brief });
            if (supported(`${out.claim} ${out.evidence}`, section.text)) {
              claim = out.claim;
              evidence = out.evidence;
              forYou = out.forYou;
              // Claim and evidence are shared; "for you" is this user's and isn't stored.
              await db
                .insert(summary)
                .values({ itemVersionId: row.versionId, sectionId, claim, evidence, method: reader.method, model: reader.model, promptVersion: "section-summary-v1" })
                .onConflictDoNothing();
            }
          } catch (err) {
            console.warn(JSON.stringify({ level: "warn", message: "section summary fell back to the plain one", error: (err as Error).message }));
          }
        }
        if (!claim || !evidence) ({ claim, evidence } = plainSummary(section.text));
        if (forYou === null && cached && useModel) {
          try {
            forYou = await reader.forYou({ title, claim, evidence, brief });
          } catch {
            forYou = null;
          }
        }
        const result: SectionSummary = { sectionId, claim, evidence, forYou: forYou ?? plainForYou(section.text, brief) };
        return c.json({ summary: result });
      },
    );
}

// ── Reading: events, saved, activity, authors, test letter ─────────────────

/** POST /events (§6.6), saved pieces, activity, following an author and the test letter. Mounted at the root, so sign-in is checked per route. */
export function readingRoutes({ detect, ...letters }: Pick<LetterRouteDeps, keyof OnDemandLetterDeps | "detect">) {
  const { db } = letters;
  const testLetterLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });

  return new Hono<AuthedEnv>()
    .post(
      "/events",
      requireUser,
      zValidator("json", eventsInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Invalid events");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { events } = c.req.valid("json");
        const itemIds = [...new Set(events.map((e) => e.itemId))];
        const letterIds = [...new Set(events.flatMap((e) => (e.letterId ? [e.letterId] : [])))];
        const [items, letters] = await Promise.all([
          db.select({ id: contentItem.id }).from(contentItem).where(inArray(contentItem.id, itemIds)),
          letterIds.length
            ? db.select({ id: letter.id }).from(letter).where(and(eq(letter.userId, userId), inArray(letter.id, letterIds)))
            : Promise.resolve([]),
        ]);
        const knownItems = new Set(items.map((i) => i.id));
        const ownLetters = new Set(letters.map((l) => l.id));
        // Events for items we don't know are dropped; a letter that isn't the user's is ignored.
        const rows = events
          .filter((e) => knownItems.has(e.itemId))
          .map((e) => ({
            eventId: e.eventId,
            userId,
            itemId: e.itemId,
            letterId: e.letterId && ownLetters.has(e.letterId) ? e.letterId : null,
            type: e.type,
            occurredAt: new Date(e.occurredAt),
            localDay: e.localDay,
          }));
        // A resent outbox carries the same event IDs: duplicates are ignored.
        if (rows.length) await db.insert(interaction).values(rows).onConflictDoNothing({ target: interaction.eventId });
        return c.json({ accepted: rows.length });
      },
    )

    .get("/me/saved", requireUser, async (c) => {
      const userId = c.get("user").id;
      const rows = await db.execute<{
        item_id: string;
        saved_at: Date;
        type: "article" | "video";
        title: string | null;
        canonical_url: string;
        read_time_minutes: number | null;
        duration_seconds: number | null;
        lead_image_url: string | null;
        icon: string | null;
        tags: string[] | null;
        publisher_name: string;
        snapshot: { topic?: string; minutes?: number; image?: SavedPiece["image"]; sourceName?: string; icon?: string } | null;
        offline: boolean | null;
      }>(sql`
        select s.item_id, s.occurred_at as saved_at, ci.type, ci.title, ci.canonical_url, ci.read_time_minutes, ci.duration_seconds,
               ci.lead_image_url, ci.icon, ci.tags, p.name as publisher_name,
               (select li.snapshot from ${letterItem} li join ${letter} l on l.id = li.letter_id
                 where li.item_id = s.item_id and l.user_id = ${userId} order by li.created_at desc limit 1) as snapshot,
               (select (cv.rights_snapshot->>'offlineAllowed')::boolean and (cv.blocks_key is not null or exists(select 1 from ${transcript} t where t.item_version_id = cv.id))
                  from ${contentVersion} cv where cv.item_id = s.item_id order by cv.fetched_at desc limit 1) as offline
        from (
          select distinct on (item_id) item_id, type, occurred_at from ${interaction}
          where user_id = ${userId} and type in ('save', 'unsave')
          order by item_id, occurred_at desc
        ) s
        join ${contentItem} ci on ci.id = s.item_id
        join ${publisher} p on p.id = ci.publisher_id
        where s.type = 'save'
        order by s.occurred_at desc
        limit 500`);
      const saved: SavedPiece[] = rows.rows.map((r) => ({
        itemId: r.item_id,
        kind: r.type,
        title: r.title ?? r.canonical_url,
        topic: r.snapshot?.topic ?? null,
        minutes: r.snapshot?.minutes ?? (r.type === "video" && r.duration_seconds ? Math.max(1, Math.round(r.duration_seconds / 60)) : r.read_time_minutes),
        sourceName: r.snapshot?.sourceName ?? r.publisher_name,
        image: r.snapshot?.image ?? (r.lead_image_url ? { url: r.lead_image_url, source: "article", credit: null, creditUrl: null } : null),
        icon: resolvePieceIcon(r.snapshot?.icon ?? r.icon, { kind: r.type, tags: r.tags, topic: r.snapshot?.topic, title: r.title }),
        savedAt: new Date(r.saved_at).toISOString(),
        offline: !!r.offline,
      }));
      return c.json({ saved });
    })

    .get(
      "/me/activity",
      requireUser,
      zValidator("query", z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send month as YYYY-MM");
      }),
      async (c) => {
      const userId = c.get("user").id;
      const { month } = c.req.valid("query");
      const [s] = await db.select({ timeZone: schedule.timeZone }).from(schedule).where(eq(schedule.userId, userId));
      const timeZone = s?.timeZone ?? "UTC";
      const first = `${month}-01`;
      const [events, reviews] = await Promise.all([
        // Completions in the month can rely on an open from before it.
        db
          .select({ type: interaction.type, itemId: interaction.itemId, occurredAt: interaction.occurredAt, localDay: interaction.localDay })
          .from(interaction)
          .where(
            and(
              eq(interaction.userId, userId),
              inArray(interaction.type, ["open", "complete", "uncomplete"]),
              sql`${interaction.localDay} < (${first}::date + interval '1 month')`,
              sql`${interaction.localDay} >= (${first}::date - interval '1 month')`,
            ),
          ),
        // A review counts on the day it was first made, in the user's time zone.
        db
          .select({ itemId: review.itemId, createdAt: review.createdAt })
          .from(review)
          .where(and(eq(review.userId, userId), sql`${review.createdAt} >= ${first}::date - interval '1 day'`, sql`${review.createdAt} < ${first}::date + interval '1 month 1 day'`)),
      ]);
      const activity: ActivityMonth = activityMonth(
        month,
        events,
        reviews.map((r) => ({ itemId: r.itemId, localDay: localDateOf(r.createdAt, timeZone) })),
      );
      return c.json({ activity });
    })

    .put(
      "/me/authors/:key/follow",
      requireUser,
      zValidator("param", z.object({ key: z.string().min(1).max(300) }), notFound("Author")),
      zValidator("json", followAuthorInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send following: true or false");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { key } = c.req.valid("param");
        const { following } = c.req.valid("json");
        const [a] = await db.select().from(author).where(eq(author.key, key));
        if (!a) return apiError(c, 404, "NOT_FOUND", "Author not found");

        if (!following) {
          // Their feed stays in the user's sources; that's managed in Sources.
          await db.delete(userAuthor).where(and(eq(userAuthor.userId, userId), eq(userAuthor.authorId, a.id)));
          return c.json({ key, following: false });
        }

        const [link] = await db
          .insert(userAuthor)
          .values({ userId, authorId: a.id })
          .onConflictDoUpdate({ target: [userAuthor.userId, userAuthor.authorId], set: { authorId: a.id } })
          .returning();
        // Their feed or channel becomes a source when we know one.
        if (a.followUrl && !link!.sourceId) {
          try {
            const detected = await detectSource(a.followUrl, detect);
            const sourceId = await addUserSource(db, { userId, mode: "more_like_this", detected });
            await db.update(userAuthor).set({ sourceId }).where(eq(userAuthor.id, link!.id));
          } catch (err) {
            console.warn(JSON.stringify({ level: "warn", message: "couldn't add the author's feed as a source", key, error: (err as Error).message }));
          }
        }
        return c.json({ key, following: true });
      },
    )

    .post("/me/schedule/test-letter", requireUser, async (c) => {
      const userId = c.get("user").id;
      if (!testLetterLimiter(userId)) return apiError(c, 429, "RATE_LIMITED", "Too many test letters. Try again in a while.");
      // `test#<uuid>` never collides with a scheduled occurrence and doesn't touch next_run_at (§6.1). With
      // too little to pick from (a new user follows nothing yet), it searches the web first, like the first letter.
      const discoverFirst = !(await hasEnoughToPick(db, userId));
      const { letterId } = await createOnDemandLetter(letters, { userId, occurrenceId: `test#${crypto.randomUUID()}`, isTest: true, discoverFirst });
      const [row] = await db.select().from(letter).where(eq(letter.id, letterId));
      return c.json({ letterId, progress: await letterProgress(db, row!) }, 202);
    });
}
