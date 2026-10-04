import { letterInputHash } from "@fs/ai";
import {
  assignFeedbackCodes,
  authorKeyFor,
  authorNeedsCheck,
  cleanAuthorName,
  briefText,
  DISCOVERED_CANDIDATE_DAYS,
  checkLetterCopy,
  checkPieceCopy,
  checkPostscript,
  fallbackHeadline,
  fallbackIntro,
  fallbackPieceCopy,
  fallbackPostscript,
  initialsFor,
  type LetterCopy,
  leaningOptions,
  nextSubstitute,
  type PieceCopy,
  publisherEvidence,
  type RankCandidate,
  rankCandidates,
  type ScoredCandidate,
  selectPassages,
  whyThisMix,
  type WriterBrief,
  type WriterInput,
  type WriterPiece,
} from "@fs/core";
import { schema } from "@fs/db";
import type { DraftCopy, GenerationMeta, LetterItemSnapshot, RankedEntry } from "@fs/db/schema";
import { and, desc, eq, exists, gt, inArray, isNotNull, ne, notExists, or, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import type { Message } from "../pipeline/messages.ts";
import { loadParagraphs, loadUserContext, type UserContext } from "./context.ts";
import { deliverLetter } from "./deliver.ts";
import { pieceImage } from "./images.ts";
import {
  claimStep,
  completeStep,
  finishLetter,
  type Letter,
  MAX_STEP_ATTEMPTS,
  NEXT_STATUS,
  releaseStep,
} from "./state.ts";

const { author, contentItem, letter, letterItem, publisher, review, source, userDiscovery, userPublisher, userSource } = schema;

/** Items older than this aren't news to anyone. */
const CANDIDATE_WINDOW_DAYS = 60;
const MAX_CANDIDATES = 300;
/** Reserve pieces the writer also writes copy for, so a substitution needs no second call. */
const RESERVE_WITH_COPY = 3;
/** "New source": the user started following it within this many days. */
const NEW_SOURCE_DAYS = 14;

/** Runs one `letter-step` message (§6.2). */
export async function letterStep(deps: PipelineDeps, { letterId, expectedStatus }: Message<"letter-step">) {
  const log = logger(deps);
  const claimed = await claimStep(deps, letterId, expectedStatus);
  if (!claimed) return { status: "stale" as const };
  const running = NEXT_STATUS[expectedStatus];

  if ((claimed.stepAttempts[running] ?? 0) > MAX_STEP_ATTEMPTS) {
    await finishLetter(deps, letterId, running, "failed", `${running}: too many attempts`);
    log("letter_failed", { letterId, step: running });
    return { status: "failed" as const };
  }

  try {
    const result =
      running === "collecting"
        ? await collect(deps, claimed)
        : running === "ranking"
          ? await rank(deps, claimed)
          : running === "generating"
            ? await generate(deps, claimed)
            : await verifyAndLock(deps, claimed);
    log("letter_step", { letterId, step: running, ...result });
    return result;
  } catch (err) {
    await releaseStep(deps, letterId, running);
    throw err;
  }
}

// ── collect ─────────────────────────────────────────────────────────────────

/**
 * Candidates (§6.2) from three places:
 * - the user's followed, non-blocked sources (published in the last
 *   CANDIDATE_WINDOW_DAYS);
 * - pages discovery found for them (§6.3a), found in the last
 *   DISCOVERED_CANDIDATE_DAYS whatever their publish date, since good finds
 *   are often evergreen; a found page that turned out to be a duplicate
 *   counts as the original;
 * - new items from trusted discovered publishers' feeds, for users discovery
 *   has shown that publisher to.
 * Minus duplicates, thin or SEO filler, publishers blocked globally or by
 * this user, sources they blocked, anything already in one of their letters
 * and anything they've reviewed. Videos only reach `extracted` with a
 * transcript, so a video without one ("saved, no skim", §6.3) is never a
 * candidate.
 */
async function collect(deps: PipelineDeps, current: Letter) {
  const { db } = deps;
  const userId = current.userId;

  const recent = gt(sql`coalesce(${contentItem.publishedAt}, ${contentItem.createdAt})`, sql`now() - make_interval(days => ${CANDIDATE_WINDOW_DAYS})`);
  const followed = and(
    recent,
    exists(
      db
        .select({ one: sql`1` })
        .from(userSource)
        .where(and(eq(userSource.sourceId, contentItem.sourceId), eq(userSource.userId, userId), eq(userSource.blocked, false))),
    ),
  );
  const discovered = exists(
    db
      .select({ one: sql`1` })
      .from(userDiscovery)
      .innerJoin(sql`${contentItem} as found`, sql`found.id = ${userDiscovery.itemId}`)
      .where(
        and(
          eq(userDiscovery.userId, userId),
          sql`(found.id = ${contentItem.id} or found.duplicate_of_id = ${contentItem.id})`,
          gt(userDiscovery.foundAt, sql`now() - make_interval(days => ${DISCOVERED_CANDIDATE_DAYS})`),
        ),
      ),
  );
  const trustedFeed = and(
    recent,
    eq(publisher.origin, "discovered"),
    eq(publisher.status, "trusted"),
    exists(
      db
        .select({ one: sql`1` })
        .from(userDiscovery)
        .innerJoin(sql`${contentItem} as found`, sql`found.id = ${userDiscovery.itemId}`)
        .where(and(eq(userDiscovery.userId, userId), sql`found.publisher_id = ${contentItem.publisherId}`)),
    ),
  );

  const rows = await db
    .select({ id: contentItem.id })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(
      and(
        or(followed, discovered, trustedFeed),
        inArray(contentItem.status, ["extracted", "enriched"]),
        sql`${contentItem.duplicateOfId} is null`,
        sql`${contentItem.title} is not null`,
        sql`coalesce(${contentItem.qualityLabel}, 'substantive') not in ('thin', 'seo_filler')`,
        ne(publisher.status, "blocked"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(userPublisher)
            .where(and(eq(userPublisher.userId, userId), eq(userPublisher.publisherId, contentItem.publisherId), eq(userPublisher.blocked, true))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(userSource)
            .where(and(eq(userSource.sourceId, contentItem.sourceId), eq(userSource.userId, userId), eq(userSource.blocked, true))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(letterItem)
            .innerJoin(letter, eq(letter.id, letterItem.letterId))
            .where(and(eq(letterItem.itemId, contentItem.id), eq(letter.userId, userId), ne(letter.id, current.id))),
        ),
        notExists(db.select({ one: sql`1` }).from(review).where(and(eq(review.itemId, contentItem.id), eq(review.userId, userId)))),
      ),
    )
    // Newest first; a discovered page counts as new when it was found.
    .orderBy(
      sql`greatest(coalesce(${contentItem.publishedAt}, ${contentItem.createdAt}),
        coalesce((select max(${userDiscovery.foundAt}) from ${userDiscovery} where ${userDiscovery.userId} = ${userId} and ${userDiscovery.itemId} = ${contentItem.id}), '-infinity'::timestamptz)) desc`,
    )
    .limit(MAX_CANDIDATES);

  const candidates = [...new Set(rows.map((r) => r.id))];
  if (!candidates.length) {
    await finishLetter(deps, current.id, "collecting", "skipped_no_candidates", "no candidates");
    return { status: "skipped_no_candidates" as const, candidates: 0 };
  }
  await completeStep(deps, current, "collecting", { candidates });
  return { status: "collected" as const, candidates: candidates.length };
}

// ── rank ────────────────────────────────────────────────────────────────────

const MODE_ORDER = { follow_closely: 3, more_like_this: 2, occasional: 1 } as const;

async function rank(deps: PipelineDeps, current: Letter) {
  const { db } = deps;
  const ids = current.work.candidates ?? [];
  const ctx = await loadUserContext(db, current.userId, current.id);
  const rows = ids.length
    ? await db
        .select({
          item: contentItem,
          publisher,
          mode: userSource.mode,
          excerpt: sql<string | null>`(select excerpt from content_version where item_id = ${contentItem.id} order by fetched_at desc limit 1)`,
          // Discovery's reason, from the user's first finding of this page (or of a duplicate of it).
          discoveredReason: sql<string | null>`(
            select ${userDiscovery.reason} from ${userDiscovery} join ${contentItem} found on found.id = ${userDiscovery.itemId}
            where ${userDiscovery.userId} = ${current.userId} and (found.id = ${contentItem.id} or found.duplicate_of_id = ${contentItem.id})
            order by ${userDiscovery.foundAt} limit 1)`,
        })
        .from(contentItem)
        .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
        .leftJoin(userSource, and(eq(userSource.sourceId, contentItem.sourceId), eq(userSource.userId, current.userId)))
        .where(inArray(contentItem.id, ids))
    : [];

  const byId = new Map<string, RankCandidate>();
  for (const r of rows) {
    const prev = byId.get(r.item.id);
    if (prev && prev.sourceMode && r.mode && MODE_ORDER[prev.sourceMode] >= MODE_ORDER[r.mode]) continue;
    byId.set(r.item.id, {
      itemId: r.item.id,
      kind: r.item.type,
      title: r.item.title ?? "",
      tags: r.item.tags ?? [],
      excerpt: r.excerpt,
      publisherId: r.item.publisherId,
      publisherName: r.publisher.name,
      authorKey: r.item.authorKey,
      sourceMode: r.mode,
      publishedAt: r.item.publishedAt,
      quality: r.item.qualityLabel,
      depth: r.item.depth,
      minutes: minutesOf(r.item),
      discoveredReason: r.discoveredReason,
      // Explore vs exploit (§6.3a.5) is for publishers discovery found and the user doesn't follow.
      catalog: r.publisher.origin === "discovered" && !r.mode ? { status: r.publisher.status, ...publisherEvidence(r.publisher) } : null,
    });
  }

  const { picks, reserve } = rankCandidates([...byId.values()], ctx.rank, { now: deps.now?.() ?? new Date(), count: ctx.itemCount });
  const ranked: RankedEntry[] = [...picks, ...reserve].map(toEntry);
  await completeStep(deps, current, "ranking", { ranked, pickCount: picks.length });
  return { status: "ranked" as const, picks: picks.length, reserve: reserve.length };
}

/** A pick's top positive signals; a `discovered` signal is always kept, so the letter can say where it came from. */
function toEntry(s: ScoredCandidate): RankedEntry {
  const positive = s.signals.filter((x) => x.weight > 0);
  const top = positive.slice(0, 4);
  const found = positive.find((x) => x.kind === "discovered");
  if (found && !top.includes(found)) top.push(found);
  return { itemId: s.itemId, score: s.score, topic: s.topic, signals: top };
}

function minutesOf(item: { type: string; durationSeconds: number | null; readTimeMinutes: number | null }): number {
  if (item.type === "video" && item.durationSeconds) return Math.max(1, Math.round(item.durationSeconds / 60));
  return Math.max(1, item.readTimeMinutes ?? 1);
}

// ── generate ────────────────────────────────────────────────────────────────

async function generate(deps: PipelineDeps, current: Letter) {
  const { db } = deps;
  const log = logger(deps);
  const ranked = current.work.ranked ?? [];
  const pickCount = current.work.pickCount ?? 0;
  const entries = ranked.slice(0, pickCount + RESERVE_WITH_COPY);
  const ctx = await loadUserContext(db, current.userId, current.id);
  const pieces = await writerPieces(deps, current.userId, entries, ctx);
  const input: WriterInput = { brief: ctx.brief, pieces, pickCount: Math.min(pickCount, pieces.length) };

  const writer = deps.letterWriter;
  let copy: LetterCopy;
  let generation: GenerationMeta = {
    method: writer.method,
    model: writer.model,
    promptVersion: writer.promptVersion,
    inputHash: letterInputHash(input),
    calls: 1,
    rejected: [],
  };
  try {
    copy = await writer.write(input);
  } catch (err) {
    // No model available (or it failed): copy from the pieces' own words, never invented.
    log("letter_writer_fallback", { letterId: current.id, message: (err as Error).message });
    copy = { headline: "", intro: "", postscript: "", pieces: pieces.map(fallbackPieceCopy) };
    generation = { ...generation, method: "fallback", model: null, fallbackReason: (err as Error).message.slice(0, 200) };
  }

  const drafts: Record<string, DraftCopy> = {};
  for (const p of copy.pieces) {
    if (pieces.some((x) => x.ref === p.ref) && !drafts[p.ref]) drafts[p.ref] = { whyPicked: p.whyPicked, summary: p.summary, tag: p.tag, evidenceIds: p.evidenceIds };
  }
  await completeStep(deps, current, "generating", {
    drafts,
    letterCopy: { headline: copy.headline, intro: copy.intro, postscript: copy.postscript },
    generation,
    writer: { brief: ctx.brief as unknown as Record<string, unknown>, pieces: pieces as unknown as Record<string, unknown>[] },
  });
  return { status: "generated" as const, method: generation.method, pieces: Object.keys(drafts).length };
}

/** Passages and context per piece: what the writer sees. Never a title alone. */
async function writerPieces(deps: PipelineDeps, userId: string, entries: RankedEntry[], ctx: UserContext): Promise<WriterPiece[]> {
  const { db } = deps;
  if (!entries.length) return [];
  const rows = await db
    .select({
      item: contentItem,
      publisherName: publisher.name,
      publisherId: publisher.id,
      followedAt: sql<Date | null>`(
        select min(${userSource.createdAt}) from ${userSource}
        join ${source} on ${source.id} = ${userSource.sourceId}
        where ${userSource.userId} = ${userId} and ${source.publisherId} = ${publisher.id})`,
      seenBefore: sql<boolean>`exists(
        select 1 from ${letterItem} join ${letter} on ${letter.id} = ${letterItem.letterId}
        join ${contentItem} ci2 on ci2.id = ${letterItem.itemId}
        where ${letter.userId} = ${userId} and ci2.publisher_id = ${publisher.id} and ${letter.deliveredAt} is not null)`,
      discovered: sql<boolean>`exists(
        select 1 from ${userDiscovery} join ${contentItem} found on found.id = ${userDiscovery.itemId}
        where ${userDiscovery.userId} = ${userId} and (found.id = ${contentItem.id} or found.duplicate_of_id = ${contentItem.id}))`,
    })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(inArray(contentItem.id, entries.map((e) => e.itemId)));
  const byId = new Map(rows.map((r) => [r.item.id, r]));
  const focus = [...ctx.brief.topics, ...(ctx.brief.lately ? [ctx.brief.lately] : []), ...ctx.brief.leanings];
  const now = deps.now?.() ?? new Date();

  const pieces: WriterPiece[] = [];
  for (const e of entries) {
    const r = byId.get(e.itemId);
    if (!r) continue;
    const passages = selectPassages(r.item.id, await loadParagraphs(db, deps.store, r.item.id), { focus });
    // Nothing is ever written from a title alone.
    if (!passages.length) continue;
    const minutes = minutesOf(r.item);
    const followedAt = r.followedAt ? new Date(r.followedAt) : null;
    const newlyFollowed = followedAt && now.getTime() - followedAt.getTime() < NEW_SOURCE_DAYS * 86_400_000;
    const allowedTags = [
      // A recently followed source, or a publisher discovery found, the first time it's in a letter.
      ...(!r.seenBefore && (newlyFollowed || r.discovered) ? ["New source"] : []),
      ...(minutes <= 5 ? ["Quick read"] : []),
      ...(minutes >= 20 || r.item.depth === "advanced" ? ["Deep dive"] : []),
    ];
    pieces.push({
      ref: r.item.id,
      kind: r.item.type,
      title: r.item.title ?? "",
      sourceName: r.publisherName,
      author: r.item.authorName,
      minutes,
      topic: e.topic,
      passages,
      allowedTags,
      signals: e.signals.map((s) => ({ kind: s.kind, detail: s.detail })),
    });
  }
  return pieces;
}

// ── verify and lock ─────────────────────────────────────────────────────────

/**
 * Deterministic checks (§6.5) on every piece; a failing piece is regenerated
 * once, then replaced from the ranked reserve. Too few left → the user's
 * short-letter policy. Then lock: feedback codes, snapshots, images, authors,
 * the P.S. options, and `ready`, in one transaction.
 */
async function verifyAndLock(deps: PipelineDeps, current: Letter) {
  const { db } = deps;
  const log = logger(deps);
  const work = current.work;
  const pieces = (work.writer?.pieces ?? []) as unknown as WriterPiece[];
  const brief = (work.writer?.brief ?? { role: null, lately: null, topics: [], leanings: [], facts: [] }) as unknown as WriterBrief;
  const generation: GenerationMeta = { ...work.generation!, rejected: [] };
  const drafts: Record<string, PieceCopy> = Object.fromEntries(Object.entries(work.drafts ?? {}).map(([ref, d]) => [ref, { ref, ...d }]));
  const ctx = await loadUserContext(db, current.userId, current.id);
  const bText = briefText(brief);
  const pieceById = new Map(pieces.map((p) => [p.ref, p]));
  const ranked = work.ranked ?? [];
  const pickCount = Math.min(work.pickCount ?? 0, ranked.length);
  const picks = ranked.slice(0, pickCount).map((r) => r.itemId);

  const check = (ref: string) => {
    const piece = pieceById.get(ref);
    const draft = drafts[ref];
    if (!piece) return ["no_passages"];
    if (!draft) return ["no_copy"];
    return checkPieceCopy(draft, piece, bText);
  };

  // Regenerate the picks that fail, once (one more call for all of them). Reserve pieces aren't
  // regenerated: a substitute without passing copy gets copy from its own words instead.
  const failing = picks.filter((ref) => pieceById.has(ref) && check(ref).length);
  if (failing.length && generation.method !== "fallback") {
    try {
      const retry = await deps.letterWriter.write({ brief, pieces: failing.map((ref) => pieceById.get(ref)!), pickCount: failing.length });
      generation.calls++;
      for (const p of retry.pieces) {
        const piece = pieceById.get(p.ref);
        if (failing.includes(p.ref) && piece && !checkPieceCopy(p, piece, bText).length) drafts[p.ref] = p;
      }
    } catch (err) {
      log("letter_regenerate_failed", { letterId: current.id, message: (err as Error).message });
    }
  }

  // Final set: picks that pass, then substitutes from the reserve.
  const scored = ranked.map((r) => ({ itemId: r.itemId, score: r.score, topic: r.topic, signals: [], publisherId: "" }) as ScoredCandidate);
  const publisherOf = await publishersOf(deps, ranked.map((r) => r.itemId));
  for (const s of scored) s.publisherId = publisherOf.get(s.itemId) ?? s.itemId;
  const reserve = scored.slice(pickCount);
  const kept: ScoredCandidate[] = [];
  const tried = new Set<string>();
  for (const ref of picks) {
    tried.add(ref);
    const reasons = check(ref);
    if (!reasons.length) {
      kept.push(scored.find((s) => s.itemId === ref)!);
      continue;
    }
    generation.rejected.push({ itemId: ref, reasons });
    for (;;) {
      const sub = nextSubstitute(reserve, kept, tried);
      if (!sub) break;
      tried.add(sub.itemId);
      const piece = pieceById.get(sub.itemId);
      if (!piece) continue;
      // A reserve piece without passing model copy gets copy from its own words, which always verifies.
      if (check(sub.itemId).length) drafts[sub.itemId] = fallbackPieceCopy(piece);
      if (check(sub.itemId).length) continue;
      kept.push(sub);
      break;
    }
  }

  const short = kept.length < ctx.itemCount;
  const verification = {
    passed: kept.map((k) => k.publisherId),
    failed: generation.rejected.map((r) => publisherOf.get(r.itemId)).filter((id): id is string => !!id),
  };
  if (!kept.length || (short && ctx.shortLetterPolicy === "skip")) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(letter)
        .set({ status: "skipped_no_candidates", failureReason: kept.length ? "short letter skipped by policy" : "nothing passed verification", generationMeta: generation, watchdogAt: null })
        .where(and(eq(letter.id, current.id), eq(letter.status, "verifying")))
        .returning({ id: letter.id });
      if (row) await recordVerification(tx, verification);
    });
    return { status: "skipped_no_candidates" as const, kept: kept.length };
  }

  await lock(deps, current, {
    kept,
    drafts,
    pieceById,
    generation,
    short,
    ctx,
    brief,
    unchanged: kept.length === picks.length && kept.every((k, i) => k.itemId === picks[i]),
    verification,
  });
  return { status: "ready" as const, pieces: kept.length, short, rejected: generation.rejected.length };
}

/**
 * Publishers' verification record (§6.3a.4): a pass for each piece that went
 * into the letter, a failure for each that was rejected. Written once, with
 * the letter's own status change.
 */
async function recordVerification(tx: Pick<PipelineDeps["db"], "update">, { passed, failed }: { passed: string[]; failed: string[] }) {
  const tally = (ids: string[]) => ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());
  for (const [id, n] of tally(passed)) {
    await tx.update(publisher).set({ verificationsPassed: sql`${publisher.verificationsPassed} + ${n}` }).where(eq(publisher.id, id));
  }
  for (const [id, n] of tally(failed)) {
    await tx.update(publisher).set({ verificationsFailed: sql`${publisher.verificationsFailed} + ${n}` }).where(eq(publisher.id, id));
  }
}

async function publishersOf(deps: PipelineDeps, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, string>();
  const rows = await deps.db.select({ id: contentItem.id, publisherId: contentItem.publisherId }).from(contentItem).where(inArray(contentItem.id, itemIds));
  return new Map(rows.map((r) => [r.id, r.publisherId]));
}

async function lock(
  deps: PipelineDeps,
  current: Letter,
  {
    kept,
    drafts,
    pieceById,
    generation,
    short,
    ctx,
    brief,
    unchanged,
    verification,
  }: {
    kept: ScoredCandidate[];
    drafts: Record<string, PieceCopy>;
    pieceById: Map<string, WriterPiece>;
    generation: GenerationMeta;
    short: boolean;
    ctx: UserContext;
    brief: WriterBrief;
    unchanged: boolean;
    verification: { passed: string[]; failed: string[] };
  },
) {
  const { db } = deps;
  const ids = kept.map((k) => k.itemId);
  const rows = await db
    .select({ item: contentItem, publisherName: publisher.name, publisherKey: publisher.key, publisherFeed: publisher.feedUrl })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(inArray(contentItem.id, ids));
  // Items extracted before bylines were kept as authors get one from their credited creator.
  for (const r of rows) {
    if (r.item.authorKey) continue;
    const name = r.item.type === "video" && r.publisherKey.startsWith("youtube:") ? r.item.creator : cleanAuthorName(r.item.creator, r.publisherName);
    if (!name) continue;
    r.item.authorName = name;
    r.item.authorKey = authorKeyFor({ name, publisherKey: r.publisherKey });
    await db.update(contentItem).set({ authorName: name, authorKey: r.item.authorKey }).where(eq(contentItem.id, r.item.id));
  }
  const byId = new Map(rows.map((r) => [r.item.id, r]));
  const ranked = new Map((current.work.ranked ?? []).map((r) => [r.itemId, r]));

  const codes = assignFeedbackCodes(
    ids.map((id) => byId.get(id)!.publisherName),
    deps.random,
  );
  const totalMinutes = ids.reduce((s, id) => s + pieceById.get(id)!.minutes, 0);

  // The model's headline and cover line only if the pieces are the ones it wrote for, and they verify.
  const modelCopy = current.work.letterCopy;
  const useModel =
    unchanged &&
    modelCopy?.headline &&
    modelCopy.intro &&
    !checkLetterCopy(modelCopy, [kept.length, totalMinutes, ...ids.map((id) => pieceById.get(id)!.minutes)], briefText(brief)).length;
  const headline = useModel ? modelCopy!.headline : fallbackHeadline(ids.map((id) => pieceById.get(id)!.topic), brief.role);
  const intro = useModel ? modelCopy!.intro : fallbackIntro(kept.length, totalMinutes);
  // The default P.S. likewise: the model's only for the pieces it wrote for, naming just them and
  // nothing beyond their delivered summaries; otherwise one from the titles. Feedback replaces it (API).
  const titled = ids.map((id) => ({ title: pieceById.get(id)!.title, summary: drafts[id]!.summary }));
  const postscriptDefault =
    unchanged && modelCopy?.postscript && !checkPostscript(modelCopy.postscript, titled).length
      ? modelCopy.postscript
      : fallbackPostscript(titled.map((t) => t.title));

  const items: (typeof letterItem.$inferInsert)[] = [];
  for (const [i, id] of ids.entries()) {
    const r = byId.get(id)!;
    const piece = pieceById.get(id)!;
    const draft = drafts[id]!;
    const snapshot: LetterItemSnapshot = {
      kind: r.item.type,
      title: piece.title,
      topic: piece.topic,
      minutes: piece.minutes,
      whyPicked: draft.whyPicked,
      summary: draft.summary,
      tag: draft.tag,
      sourceName: r.publisherName,
      originalUrl: r.item.canonicalUrl,
      image: await pieceImage({ stock: deps.stockPhotos, images: deps.images }, r.item, piece.topic),
      author: r.item.authorKey && r.item.authorName ? { key: r.item.authorKey, name: r.item.authorName } : null,
      evidenceIds: draft.evidenceIds,
      profileVersion: ctx.profileVersion,
    };
    items.push({ letterId: current.id, itemId: id, position: i + 1, feedbackCode: codes[i]!, snapshot, pickSignals: ranked.get(id)?.signals ?? [] });
  }

  // P.S. options and the "why this mix" line, from feedback since the previous letter.
  const recent = await recentFeedback(deps, current.userId, ctx.previous?.deliveredAt ?? null);
  const leanings = leaningOptions({
    topics: brief.topics,
    feedback: recent.map((f) => ({ vote: f.vote, reasons: f.reasons, topic: f.topic })),
    letterTopics: ids.map((id) => pieceById.get(id)!.topic),
  });
  const mix = whyThisMix({
    feedback: recent.map((f) => ({ vote: f.vote, reasons: f.reasons, topic: f.topic, publisherName: f.publisherName, at: f.at })),
    chosenLeanings: ctx.previous?.chosenLeanings ?? [],
    timeZone: ctx.timeZone,
  });

  const authorRows = rows
    .filter((r) => r.item.authorKey && r.item.authorName)
    .map((r) => ({
      key: r.item.authorKey!,
      name: r.item.authorName!,
      initials: initialsFor(r.item.authorName!),
      // A channel can always be followed; a byline's own feed is found by enrichment.
      followUrl: r.item.authorKey!.startsWith("youtube:") ? `https://www.youtube.com/channel/${r.item.authorKey!.slice("youtube:".length)}` : null,
    }));

  const locked = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(letter)
      .set({
        status: "ready",
        headline,
        intro,
        postscriptDefault,
        whyThisMix: mix,
        leanings,
        short,
        generationMeta: generation,
        work: { ...current.work, drafts: Object.fromEntries(Object.entries(drafts).map(([k, { ref: _, ...d }]) => [k, d])) },
        watchdogAt: null,
        // A test letter goes out as soon as it's ready.
        scheduledFor: current.isTest ? sql`least(${letter.scheduledFor}, now())` : letter.scheduledFor,
      })
      .where(and(eq(letter.id, current.id), eq(letter.status, "verifying")))
      .returning({ id: letter.id });
    if (!row) return false;
    await tx.delete(letterItem).where(eq(letterItem.letterId, current.id));
    await tx.insert(letterItem).values(items);
    if (authorRows.length) await tx.insert(author).values(authorRows).onConflictDoNothing({ target: author.key });
    await recordVerification(tx, verification);
    return true;
  });
  if (!locked) return;

  // Author details are looked up out of band; the card shows the name until then.
  if (authorRows.length) {
    const due = await db
      .select({ key: author.key, checkedAt: author.checkedAt })
      .from(author)
      .where(inArray(author.key, authorRows.map((a) => a.key)));
    const now = deps.now?.() ?? new Date();
    for (const a of due) if (authorNeedsCheck(a.checkedAt, now)) await deps.queues.send("author", { authorKey: a.key });
  }

  await deliverLetter(deps, current.id);
}

/** Reviews since the previous letter (or the last week), with the topic the piece had and its publisher. */
async function recentFeedback(deps: PipelineDeps, userId: string, since: Date | null) {
  const rows = await deps.db
    .select({
      vote: review.vote,
      reasons: review.reasons,
      at: review.editedAt,
      tags: contentItem.tags,
      publisherName: publisher.name,
      letterTopic: sql<string | null>`(select ${letterItem.snapshot}->>'topic' from ${letterItem} where ${letterItem.itemId} = ${contentItem.id} order by ${letterItem.createdAt} desc limit 1)`,
    })
    .from(review)
    .innerJoin(contentItem, eq(contentItem.id, review.itemId))
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(
      and(
        eq(review.userId, userId),
        or(isNotNull(sql`nullif(array_length(${review.reasons}, 1), 0)`), eq(review.vote, "interested")),
        gt(review.editedAt, since ?? sql`now() - interval '7 days'`),
      ),
    )
    .orderBy(desc(review.editedAt))
    .limit(30);
  return rows.map((r) => ({ vote: r.vote, reasons: r.reasons, at: r.at, publisherName: r.publisherName, topic: r.letterTopic ?? r.tags?.[0] ?? null }));
}
