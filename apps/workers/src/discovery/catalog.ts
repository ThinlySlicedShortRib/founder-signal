import { DISTRUST_REASONS, NEUTRAL_DISLIKE_REASONS, publisherVerdict, userPublisherVerdict } from "@fs/core";
import { type Db, schema } from "@fs/db";
import { canonicalizeUrl } from "@fs/ingest";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";

const { contentItem, publisher, review, source, userPublisher } = schema;

/** A discovered publisher's record is re-evaluated at most this often. */
const EVALUATE_EVERY_MINUTES = 60;
const MAX_PER_PASS = 100;

/**
 * The publisher catalog pass (build plan §6.3a.4), run by the sweep: for
 * discovered publishers due a look, recompute their quality and vote counts
 * from their items, apply the promotion and blocking rules (@fs/core
 * `publisherVerdict`), and give a newly trusted publisher with a feed a shared
 * source, so it's polled rather than searched for again.
 */
export async function evaluatePublishers(deps: PipelineDeps, { publisherIds }: { publisherIds?: string[] } = {}) {
  const { db } = deps;
  const log = logger(deps);

  const due = await db
    .select()
    .from(publisher)
    .where(
      and(
        eq(publisher.origin, "discovered"),
        ne(publisher.status, "blocked"),
        publisherIds
          ? inArray(publisher.id, publisherIds)
          : or(isNull(publisher.evaluatedAt), lt(publisher.evaluatedAt, sql`now() - make_interval(mins => ${EVALUATE_EVERY_MINUTES})`)),
      ),
    )
    .orderBy(sql`${publisher.evaluatedAt} nulls first`)
    .limit(MAX_PER_PASS);
  if (!due.length) return { evaluated: 0, changed: 0 };

  const ids = due.map((p) => p.id);
  const [quality, votes] = await Promise.all([
    db
      .select({
        publisherId: contentItem.publisherId,
        substantive: sql<number>`count(*) filter (where ${contentItem.qualityLabel} = 'substantive')::int`,
        low: sql<number>`count(*) filter (where ${contentItem.qualityLabel} in ('thin', 'rewritten', 'seo_filler'))::int`,
      })
      .from(contentItem)
      .where(and(inArray(contentItem.publisherId, ids), isNull(contentItem.duplicateOfId)))
      .groupBy(contentItem.publisherId),
    db
      .select({
        publisherId: contentItem.publisherId,
        interested: sql<number>`count(*) filter (where ${review.vote} = 'interested')::int`,
        notInterested: sql<number>`count(*) filter (where ${review.vote} = 'not_interested')::int`,
      })
      .from(review)
      .innerJoin(contentItem, eq(contentItem.id, review.itemId))
      .where(inArray(contentItem.publisherId, ids))
      .groupBy(contentItem.publisherId),
  ]);
  const qualityBy = new Map(quality.map((q) => [q.publisherId, q]));
  const votesBy = new Map(votes.map((v) => [v.publisherId, v]));

  let changed = 0;
  for (const p of due) {
    const counts = {
      substantiveCount: qualityBy.get(p.id)?.substantive ?? 0,
      lowQualityCount: qualityBy.get(p.id)?.low ?? 0,
      interestedCount: votesBy.get(p.id)?.interested ?? 0,
      notInterestedCount: votesBy.get(p.id)?.notInterested ?? 0,
    };
    const verdict = publisherVerdict({ ...p, ...counts });
    const moved = verdict.status !== p.status;
    await db
      .update(publisher)
      .set({
        ...counts,
        evaluatedAt: sql`now()`,
        ...(moved ? { status: verdict.status, statusReason: verdict.reason, statusChangedAt: sql`now()` } : {}),
      })
      .where(and(eq(publisher.id, p.id), eq(publisher.status, p.status)));
    if (!moved) continue;
    changed++;
    log("publisher_status", { publisherId: p.id, key: p.key, from: p.status, to: verdict.status, reason: verdict.reason });
    if (verdict.status === "trusted" && p.feedUrl) await ensureSharedSource(db, { ...p, feedUrl: p.feedUrl });
  }
  return { evaluated: due.length, changed };
}

/**
 * A trusted publisher's feed as a shared source. Nobody follows it: the sweep
 * polls it because its publisher is trusted, and collect offers its new items
 * to users who were shown the publisher by discovery.
 */
async function ensureSharedSource(db: Db, p: { id: string; name: string; feedUrl: string }) {
  let canonicalKey: string;
  try {
    canonicalKey = canonicalizeUrl(p.feedUrl);
  } catch {
    return;
  }
  await db
    .insert(source)
    .values({ canonicalKey, type: "feed", publisherId: p.id, title: p.name, inputUrl: p.feedUrl, fetchUrl: p.feedUrl, nextFetchAt: new Date() })
    .onConflictDoNothing({ target: source.canonicalKey });
}

/**
 * Applies a user's own votes to the discovered publishers they've read
 * (@fs/core `userPublisherVerdict`): a publisher their votes rule out is
 * blocked for them. Blocks only get added here, and a choice the user made
 * themselves (`blocked_reason = 'user'`) is never overridden. Returns the keys
 * of every publisher blocked for this user.
 */
export async function refreshUserPublisherBlocks(db: Db, userId: string): Promise<string[]> {
  const tallies = await db
    .select({
      publisherId: contentItem.publisherId,
      interested: sql<number>`count(*) filter (where ${review.vote} = 'interested')::int`,
      notInterested: sql<number>`count(*) filter (where ${review.vote} = 'not_interested' and not (${review.reasons} && ${textArray(NEUTRAL_DISLIKE_REASONS)}))::int`,
      distrusted: sql<number>`count(*) filter (where ${review.vote} = 'not_interested' and ${review.reasons} && ${textArray(DISTRUST_REASONS)})::int`,
    })
    .from(review)
    .innerJoin(contentItem, eq(contentItem.id, review.itemId))
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(and(eq(review.userId, userId), eq(publisher.origin, "discovered")))
    .groupBy(contentItem.publisherId);

  for (const t of tallies) {
    const verdict = userPublisherVerdict(t);
    if (!verdict.blocked) continue;
    await db
      .insert(userPublisher)
      .values({ userId, publisherId: t.publisherId, blocked: true, blockedReason: `votes:${verdict.reason}`, blockedAt: new Date() })
      .onConflictDoUpdate({
        target: [userPublisher.userId, userPublisher.publisherId],
        set: { blocked: true, blockedReason: `votes:${verdict.reason}`, blockedAt: new Date() },
        setWhere: sql`${userPublisher.blocked} = false and ${userPublisher.blockedReason} is distinct from 'user'`,
      });
  }

  const blocked = await db
    .select({ key: publisher.key })
    .from(userPublisher)
    .innerJoin(publisher, eq(publisher.id, userPublisher.publisherId))
    .where(and(eq(userPublisher.userId, userId), eq(userPublisher.blocked, true)));
  return blocked.map((b) => b.key);
}

/** Publishers blocked for everyone by the catalog rules. */
export async function globallyBlockedKeys(db: Db): Promise<string[]> {
  const rows = await db.select({ key: publisher.key }).from(publisher).where(eq(publisher.status, "blocked"));
  return rows.map((r) => r.key);
}

/** A text[] parameter list, for `&&` against `review.reasons`. */
function textArray(values: readonly string[]) {
  return sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
}
