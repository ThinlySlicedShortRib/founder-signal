import type { ProfileImporter, ProfileReading } from "@fs/ai";
import { DELIVERY_PRESETS, isValidTimeZone, nextRunAt, parseProfileNote, quoteFrom, screenFacts, topicsFromText } from "@fs/core";
import { type Db, schema } from "@fs/db";
import {
  type Assistant,
  type CalibrationPick,
  deliveryPresets,
  type DeliveryPreset,
  type ImportProfileResult,
  importProfileInputSchema,
  type ProfileFact,
  type ProfileView,
  type SavedImport,
  topics as allTopics,
  updateProfileInputSchema,
  updateScheduleInputSchema,
} from "@fs/schema";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { apiError } from "../lib/errors.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { contentItem, contentVersion, profile, profileImport, publisher, review, schedule, topicWeight, userSource } = schema;

export interface ProfileRouteDeps {
  db: Db;
  /** Reads an imported profile with a model; null uses the plain parser only (local development). */
  profileImporter: ProfileImporter | null;
}

/** /me/preferences and /me/schedule (build plan §7). */
export function preferenceRoutes({ db }: Pick<ProfileRouteDeps, "db">) {
  return new Hono<AuthedEnv>()
    .use(requireUser)

    .get("/preferences", async (c) => c.json({ profile: await loadProfileView(db, c.get("user").id) }))

    .put(
      "/preferences",
      zValidator("json", updateProfileInputSchema, (result, c) => {
        if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Invalid preferences");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const input = c.req.valid("json");
        const importId = input.imported?.importId ?? null;
        if (importId) {
          const [owned] = await db
            .select({ id: profileImport.id })
            .from(profileImport)
            .where(and(eq(profileImport.id, importId), eq(profileImport.userId, userId)));
          if (!owned) return apiError(c, 404, "NOT_FOUND", "Import not found");
        }
        await db.transaction(async (tx) => {
          const set: Partial<typeof profile.$inferInsert> = {};
          if (input.role !== undefined) set.role = input.role;
          if (input.lately !== undefined) set.lately = input.lately || null;
          if (input.platforms !== undefined) set.platforms = dedupe(input.platforms);
          if (input.imported !== undefined) {
            set.importedFrom = input.imported?.assistant ?? null;
            set.importId = importId;
            // Screened again: the client sends back what it was shown, but it's still user input.
            set.importedFacts = input.imported ? screenFacts(input.imported.facts).facts : [];
          }
          await tx
            .insert(profile)
            .values({ userId, ...set })
            .onConflictDoUpdate({ target: profile.userId, set: { ...set, version: sql`${profile.version} + 1` } });

          if (input.topics !== undefined) {
            const wanted = dedupe(input.topics);
            // Explicit topics are replaced as a set; learned weights (M6) are left alone.
            await tx
              .delete(topicWeight)
              .where(
                and(
                  eq(topicWeight.userId, userId),
                  eq(topicWeight.origin, "explicit"),
                  wanted.length ? notInArray(topicWeight.topic, wanted) : undefined,
                ),
              );
            if (wanted.length) {
              await tx
                .insert(topicWeight)
                .values(wanted.map((topic) => ({ userId, topic, origin: "explicit" as const })))
                .onConflictDoUpdate({ target: [topicWeight.userId, topicWeight.topic], set: { origin: "explicit", weight: 1 } });
            }
          }
        });
        return c.json({ profile: await loadProfileView(db, userId) });
      },
    )

    .put(
      "/schedule",
      zValidator("json", updateScheduleInputSchema, (result, c) => {
        if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Send a preset and a time zone");
      }),
      async (c) => {
        const userId = c.get("user").id;
        const { preset, timeZone } = c.req.valid("json");
        if (!isValidTimeZone(timeZone)) return apiError(c, 400, "VALIDATION_FAILED", "Unknown time zone");
        const rule = { ...DELIVERY_PRESETS[preset], timeZone };
        const values = { preset, ...rule, nextRunAt: nextRunAt(rule, new Date()) };
        await db
          .insert(schedule)
          .values({ userId, ...values })
          .onConflictDoUpdate({ target: schedule.userId, set: { ...values, skipNext: false, version: sql`${schedule.version} + 1` } });
        return c.json({ profile: await loadProfileView(db, userId) });
      },
    );
}

const PICK_COUNT = 5;
const PICK_POOL = 200;

/** /me/onboarding: reading an imported profile, the five quick picks, finishing. */
export function onboardingRoutes({ db, profileImporter }: ProfileRouteDeps) {
  // Each import is a model call; this keeps a stuck client from running up a bill.
  const importLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });

  return new Hono<AuthedEnv>()
    .use(requireUser)

    .post(
      "/import",
      zValidator("json", importProfileInputSchema, (result, c) => {
        if (!result.success) return apiError(c, 400, "VALIDATION_FAILED", "Paste what your assistant wrote (up to 20,000 characters)");
      }),
      async (c) => {
        if (!importLimiter(c.get("user").id)) return apiError(c, 429, "RATE_LIMITED", "Too many imports. Try again in a while.");
        const userId = c.get("user").id;
        const input = c.req.valid("json");
        const { reading, method, model, promptVersion } = await readImport(profileImporter, input);
        // The note is kept with its reading, so the user can come back to it (and a reading can be
        // reproduced). It isn't logged.
        const [saved] = await db
          .insert(profileImport)
          .values({ userId, assistant: input.assistant, rawText: input.text, result: reading, method, model, promptVersion })
          .returning({ id: profileImport.id });
        const result: ImportProfileResult = { importId: saved!.id, ...reading };
        return c.json({ result });
      },
    )

    .get("/import/latest", async (c) => {
      const [row] = await db
        .select()
        .from(profileImport)
        .where(eq(profileImport.userId, c.get("user").id))
        .orderBy(desc(profileImport.createdAt))
        .limit(1);
      const latest: SavedImport | null = row
        ? {
            id: row.id,
            assistant: row.assistant as Assistant,
            text: row.rawText,
            result: { importId: row.id, facts: row.result.facts as ProfileFact[], dropped: row.result.dropped as ImportProfileResult["dropped"] },
            createdAt: row.createdAt.toISOString(),
          }
        : null;
      return c.json({ import: latest });
    })

    .get("/picks", async (c) => {
      const picks = await loadCalibrationPicks(db, c.get("user").id);
      return c.json({ picks });
    })

    .post("/complete", async (c) => {
      const userId = c.get("user").id;
      await db
        .insert(profile)
        .values({ userId, onboardedAt: new Date() })
        .onConflictDoUpdate({ target: profile.userId, set: { onboardedAt: sql`coalesce(${profile.onboardedAt}, now())` } });
      return c.json({ profile: await loadProfileView(db, userId) });
    });
}

interface ImportReading {
  reading: ProfileReading;
  method: "anthropic" | "claude-cli" | "parser";
  model: string | null;
  promptVersion: string | null;
}

const PARSER: Omit<ImportReading, "reading"> = { method: "parser", model: null, promptVersion: null };

/** Claude's structured reading of the note when available, otherwise (or if it fails) the plain parser. */
async function readImport(importer: ProfileImporter | null, input: { assistant: Assistant; text: string }): Promise<ImportReading> {
  if (!importer) return { reading: parseProfileNote(input.text), ...PARSER };
  try {
    const read = await importer.read(input);
    // The model's work is checked again, and anything it set aside is counted with ours.
    const screened = screenFacts(read.facts);
    return {
      reading: { facts: screened.facts, dropped: [...read.dropped, ...screened.dropped] },
      method: importer.method,
      model: importer.model,
      promptVersion: importer.promptVersion,
    };
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", message: "profile import fell back to the plain parser", error: (err as Error).message }));
    return { reading: parseProfileNote(input.text), ...PARSER };
  }
}

/** Keeps the first spelling of each answer, ignoring case. */
function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

const catalogIndex = (topic: string) => {
  const i = (allTopics as readonly string[]).indexOf(topic);
  return i < 0 ? allTopics.length : i;
};

export async function loadProfileView(db: Db, userId: string): Promise<ProfileView> {
  const [[p], topics, [s]] = await Promise.all([
    db.select().from(profile).where(eq(profile.userId, userId)),
    db
      .select({ topic: topicWeight.topic })
      .from(topicWeight)
      .where(and(eq(topicWeight.userId, userId), eq(topicWeight.origin, "explicit")))
      .orderBy(asc(topicWeight.topic)),
    db.select().from(schedule).where(eq(schedule.userId, userId)),
  ]);
  return {
    role: p?.role ?? null,
    lately: p?.lately ?? null,
    // Suggested topics in catalog order, then the user's own alphabetically, so a profile reads the
    // same however its topics were picked.
    topics: topics.map((t) => t.topic).sort((a, b) => catalogIndex(a) - catalogIndex(b) || a.localeCompare(b, "en", { sensitivity: "base" })),
    platforms: p?.platforms ?? [],
    imported: p?.importedFrom ? { importId: p.importId, assistant: p.importedFrom as Assistant, facts: p.importedFacts as ProfileFact[] } : null,
    schedule: s
      ? {
          preset: deliveryPresets.includes(s.preset as DeliveryPreset) ? (s.preset as DeliveryPreset) : null,
          weekdays: s.weekdays,
          localTime: s.localTime,
          timeZone: s.timeZone,
          paused: s.paused,
          nextRunAt: s.nextRunAt?.toISOString() ?? null,
        }
      : null,
    onboardedAt: p?.onboardedAt?.toISOString() ?? null,
  };
}

/**
 * Five pieces for onboarding's quick picks, from what's already been
 * collected: up to four that match the user's topics (one per publisher and,
 * where possible, per topic), then a wildcard from outside them.
 */
async function loadCalibrationPicks(db: Db, userId: string): Promise<CalibrationPick[]> {
  const [userTopics, candidates] = await Promise.all([
    db
      .select({ topic: topicWeight.topic })
      .from(topicWeight)
      .where(eq(topicWeight.userId, userId))
      .orderBy(desc(topicWeight.weight), asc(topicWeight.createdAt)),
    db
      .select({
        id: contentItem.id,
        type: contentItem.type,
        title: contentItem.title,
        creator: contentItem.creator,
        readTimeMinutes: contentItem.readTimeMinutes,
        tags: contentItem.tags,
        publisherId: publisher.id,
        publisherName: publisher.name,
        followed: sql<boolean>`exists(
          select 1 from ${userSource}
          where ${userSource.sourceId} = ${contentItem.sourceId}
            and ${userSource.userId} = ${userId} and not ${userSource.blocked})`,
        // The latest version's excerpt, for the pull quote.
        excerpt: sql<string | null>`(
          select ${contentVersion.excerpt} from ${contentVersion}
          where ${contentVersion.itemId} = ${contentItem.id}
          order by ${contentVersion.fetchedAt} desc limit 1)`,
      })
      .from(contentItem)
      .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
      .where(
        and(
          inArray(contentItem.status, ["extracted", "enriched"]),
          isNull(contentItem.duplicateOfId),
          sql`${contentItem.title} is not null`,
          sql`coalesce(${contentItem.qualityLabel}, 'substantive') not in ('thin', 'seo_filler')`,
          sql`${publisher.status} <> 'blocked'`,
          notExists(db.select({ one: sql`1` }).from(review).where(and(eq(review.itemId, contentItem.id), eq(review.userId, userId)))),
        ),
      )
      .orderBy(sql`${contentItem.publishedAt} desc nulls last`)
      .limit(PICK_POOL),
  ]);

  const wanted = userTopics.map((t) => t.topic);
  const scored = candidates.map((item) => {
    const about = topicsFromText(`${item.title} ${(item.tags ?? []).join(" ")}`);
    return { item, matched: wanted.find((t) => about.includes(t as never)) ?? null, quote: quoteFrom(item.excerpt) };
  });
  // Cards with a quote first: the card is designed around it.
  scored.sort((a, b) => Number(!!b.quote) - Number(!!a.quote));

  const chosen: typeof scored = [];
  const publishers = new Set<string>();
  const topicsUsed = new Set<string>();
  const take = (pick: (typeof scored)[number]) => {
    chosen.push(pick);
    publishers.add(pick.item.publisherId);
    if (pick.matched) topicsUsed.add(pick.matched);
  };
  const fresh = (s: (typeof scored)[number]) => !chosen.includes(s) && !publishers.has(s.item.publisherId);

  // Matches on new topics, then matches on any topic, then a wildcard, then anything left.
  for (const s of scored) if (chosen.length < PICK_COUNT - 1 && s.matched && !topicsUsed.has(s.matched) && fresh(s)) take(s);
  for (const s of scored) if (chosen.length < PICK_COUNT - 1 && s.matched && fresh(s)) take(s);
  const wildcard = scored.find((s) => !s.matched && !s.item.followed && fresh(s)) ?? scored.find((s) => !s.matched && fresh(s));
  if (wildcard) take(wildcard);
  for (const s of scored) if (chosen.length < PICK_COUNT && fresh(s)) take(s);
  for (const s of scored) if (chosen.length < PICK_COUNT && !chosen.includes(s)) take(s);

  return chosen.map(({ item, matched, quote }) => ({
    id: item.id,
    type: item.type,
    title: item.title!,
    publisher: item.publisherName,
    creator: item.creator,
    readTimeMinutes: item.readTimeMinutes,
    quote,
    matchedTopic: matched,
    fromFollowedSource: item.followed,
    tags: item.tags ?? [],
  }));
}
