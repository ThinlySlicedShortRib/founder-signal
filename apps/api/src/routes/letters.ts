import type { Db } from "@fs/db";
import { schema } from "@fs/db";
import { type ActivityMonth, eventsInputSchema, followAuthorInputSchema, leaningsInputSchema, type LetterSummary, type SavedPiece } from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.ts";
import { fixtureItem, fixtureLetter, fixtureSummary, FIXTURE_LETTER_ID } from "../lib/letter-fixture.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

/**
 * TODO(M3): every handler here returns fixture data in the final response
 * shapes (see @fs/schema "Letters"), so the app can be built while the letter
 * engine is. Replace each body with the real implementation; keep the routes,
 * methods, inputs and response shapes.
 */

const idParam = z.object({ id: z.uuid() });

async function nextLetterAt(db: Db, userId: string): Promise<string | null> {
  const [s] = await db.select({ next: schema.schedule.nextRunAt, paused: schema.schedule.paused }).from(schema.schedule).where(eq(schema.schedule.userId, userId));
  return s && !s.paused ? (s.next?.toISOString() ?? null) : null;
}

/** /letters: today's letter, past letters, one letter, and the P.S. choices. */
export function letterRoutes({ db }: { db: Db }) {
  return new Hono<AuthedEnv>()
    .use(requireUser)

    .get("/today", async (c) => {
      // TODO(M3): the user's most recent delivered (or test) letter, or null.
      return c.json({ letter: fixtureLetter(await nextLetterAt(db, c.get("user").id)) });
    })

    .get("/", zValidator("query", z.object({ cursor: z.string().optional() })), async (c) => {
      // TODO(M3): newest first, paginated by cursor.
      const l = fixtureLetter(null);
      const letters: LetterSummary[] = [{ id: l.id, number: l.number, headline: l.headline, localDate: l.localDate, totalMinutes: l.totalMinutes, isTest: l.isTest, pieceCount: l.pieces.length }];
      return c.json({ letters, nextCursor: null as string | null });
    })

    .get(
      "/:id",
      zValidator("param", idParam, (r, c) => {
        if (!r.success) return apiError(c, 404, "NOT_FOUND", "Letter not found");
      }),
      async (c) => {
        if (c.req.valid("param").id !== FIXTURE_LETTER_ID) return apiError(c, 404, "NOT_FOUND", "Letter not found");
        return c.json({ letter: fixtureLetter(await nextLetterAt(db, c.get("user").id)) });
      },
    )

    .put(
      "/:id/leanings",
      zValidator("param", idParam, (r, c) => {
        if (!r.success) return apiError(c, 404, "NOT_FOUND", "Letter not found");
      }),
      zValidator("json", leaningsInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send the chosen leanings");
      }),
      async (c) => {
        // TODO(M3): store on the letter; the next letter's collect/rank step reads them as a one-off hint.
        const letter = fixtureLetter(await nextLetterAt(db, c.get("user").id));
        return c.json({ postscript: { ...letter.postscript, chosenLeanings: c.req.valid("json").chosen } });
      },
    );
}

/** /items/:id (the reader) and /items/:id/summary. Reviews live in reviews.ts on the same prefix. */
export function itemRoutes() {
  return new Hono<AuthedEnv>()
    .use(requireUser)
    .get(
      "/:id",
      zValidator("param", idParam, (r, c) => {
        if (!r.success) return apiError(c, 404, "NOT_FOUND", "Item not found");
      }),
      (c) => {
        // TODO(M3): blocks from the content store when rights allow, a digest otherwise, the transcript for videos.
        const item = fixtureItem(c.req.valid("param").id);
        if (!item) return apiError(c, 404, "NOT_FOUND", "Item not found");
        return c.json({ item });
      },
    )
    .post(
      "/:id/summary",
      zValidator("param", idParam, (r, c) => {
        if (!r.success) return apiError(c, 404, "NOT_FOUND", "Item not found");
      }),
      zValidator("json", z.object({ sectionId: z.string().min(1).max(40) }), (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a sectionId");
      }),
      (c) => {
        // TODO(M3): cached per (version, section); "for you" is per user and not cached (§6.5).
        return c.json({ summary: fixtureSummary(c.req.valid("json").sectionId) });
      },
    );
}

/** POST /events (§6.6), and following an author. Mounted at the root, so sign-in is checked per route. */
export function readingRoutes() {
  return new Hono<AuthedEnv>()
    .post(
      "/events",
      requireUser,
      zValidator("json", eventsInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Invalid events");
      }),
      (c) => {
        // TODO(M3): insert into `interaction`, ignoring duplicate event IDs.
        return c.json({ accepted: c.req.valid("json").events.length });
      },
    )
    .get("/me/saved", requireUser, (c) => {
      // TODO(M3): from `save`/`unsave` events, newest first.
      const l = fixtureLetter(null);
      const saved: SavedPiece[] = l.pieces.slice(0, 2).map((p, i) => ({ itemId: p.itemId, kind: p.kind, title: p.title, topic: p.topic, minutes: p.minutes, sourceName: p.sourceName, image: p.image, savedAt: new Date(Date.now() - i * 86_400_000).toISOString(), offline: true }));
      return c.json({ saved });
    })
    .get("/me/activity", requireUser, zValidator("query", z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) })), (c) => {
      // TODO(M3): count distinct items opened+completed or reviewed per local day (§6.6), bucketed into 4 levels.
      const { month } = c.req.valid("query");
      const [y, m] = month.split("-").map(Number) as [number, number];
      const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const LV = [0, 2, 1, 0, 0, 1, 3, 2, 0, 1, 0, 0, 0, 1, 2, 3, 0, 0, 0, 1, 2, 0, 1, 2, 0, 0, 0, 3, 2, 1, 0];
      const days = Array.from({ length: n }, (_, i) => ({ day: `${month}-${String(i + 1).padStart(2, "0")}`, level: LV[i] ?? 0, read: LV[i] ?? 0, reviewed: Math.max(0, (LV[i] ?? 0) - 1) }));
      const activity: ActivityMonth = { month, activeDays: days.filter((d) => d.level > 0).length, days };
      return c.json({ activity });
    })
    .put(
      "/me/authors/:key/follow",
      requireUser,
      zValidator("json", followAuthorInputSchema, (r, c) => {
        if (!r.success) return apiError(c, 400, "VALIDATION_FAILED", "Send following: true or false");
      }),
      (c) => {
        // TODO(M3): follow the author's feed or channel as a source when we know one.
        return c.json({ key: c.req.param("key"), following: c.req.valid("json").following });
      },
    );
}
