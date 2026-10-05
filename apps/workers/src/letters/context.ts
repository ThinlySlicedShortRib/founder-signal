import { piecesWanted, type RankProfile, type RankReview, type WriterBrief } from "@fs/core";
import { type Db, schema } from "@fs/db";
import type { ContentStore, TranscriptSegment } from "@fs/ingest";
import type { Block } from "@fs/schema";
import { and, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";

const { contentItem, contentVersion, letter, letterItem, profile, review, schedule, topicWeight, transcript } = schema;

/** What the user has told us and done, for ranking and writing (§6.4, §6.5). */
export interface UserContext {
  brief: WriterBrief;
  rank: RankProfile;
  profileVersion: number | null;
  timeZone: string;
  /** Pieces the letter is planned with: the schedule's count, never below MIN_PIECES. */
  itemCount: number;
  shortLetterPolicy: "shorten" | "skip";
  /** The previous delivered letter, if any: its chosen leanings feed this one. */
  previous: { id: string; deliveredAt: Date; chosenLeanings: string[] } | null;
}

/** Reviews older than this don't steer ranking. */
const REVIEW_WINDOW_DAYS = 90;

export async function loadUserContext(db: Db, userId: string, letterId: string): Promise<UserContext> {
  const [[p], topics, [s], [previous], reviews] = await Promise.all([
    db.select().from(profile).where(eq(profile.userId, userId)),
    db.select({ topic: topicWeight.topic, weight: topicWeight.weight, origin: topicWeight.origin }).from(topicWeight).where(eq(topicWeight.userId, userId)),
    db.select().from(schedule).where(eq(schedule.userId, userId)),
    db
      .select({ id: letter.id, deliveredAt: letter.deliveredAt, chosenLeanings: letter.chosenLeanings })
      .from(letter)
      .where(and(eq(letter.userId, userId), ne(letter.id, letterId), isNotNull(letter.deliveredAt)))
      .orderBy(desc(letter.deliveredAt))
      .limit(1),
    db
      .select({
        vote: review.vote,
        reasons: review.reasons,
        tags: contentItem.tags,
        title: contentItem.title,
        publisherId: contentItem.publisherId,
        authorKey: contentItem.authorKey,
        // The topic the piece had in a letter, which the user saw.
        letterTopic: sql<string | null>`(select ${letterItem.snapshot}->>'topic' from ${letterItem} where ${letterItem.itemId} = ${contentItem.id} order by ${letterItem.createdAt} desc limit 1)`,
      })
      .from(review)
      .innerJoin(contentItem, eq(contentItem.id, review.itemId))
      .where(and(eq(review.userId, userId), gte(review.editedAt, sql`now() - make_interval(days => ${REVIEW_WINDOW_DAYS})`)))
      .orderBy(desc(review.editedAt))
      .limit(200),
  ]);

  const explicit = topics.filter((t) => t.origin === "explicit").map((t) => t.topic);
  const chosen = previous?.chosenLeanings ?? [];
  const rankReviews: RankReview[] = reviews.map((r) => ({
    vote: r.vote,
    reasons: r.reasons,
    tags: [...(r.letterTopic ? [r.letterTopic] : []), ...(r.tags ?? [])],
    title: r.title,
    publisherId: r.publisherId,
    authorKey: r.authorKey,
  }));
  return {
    brief: {
      role: p?.role ?? null,
      lately: p?.lately ?? null,
      topics: explicit,
      leanings: chosen,
      facts: (p?.importedFacts ?? []).map((f) => f.text).slice(0, 12),
    },
    rank: { topics: topics.map((t) => ({ topic: t.topic, weight: t.weight })), lately: p?.lately ?? null, leanings: chosen, reviews: rankReviews },
    profileVersion: p?.version ?? null,
    timeZone: s?.timeZone ?? "UTC",
    itemCount: piecesWanted(s?.itemCount),
    shortLetterPolicy: s?.shortLetterPolicy === "skip" ? "skip" : "shorten",
    previous: previous?.deliveredAt ? { id: previous.id, deliveredAt: previous.deliveredAt, chosenLeanings: chosen } : null,
  };
}

/** ~100-word paragraphs from a transcript, so videos get passages like articles. */
function transcriptParagraphs(segments: TranscriptSegment[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const s of segments) {
    current = `${current} ${s.text.trim()}`.trim();
    if (current.split(/\s+/).length >= 100) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

function blockParagraphs(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" || b.type === "quote") out.push(b.text);
    else if (b.type === "list") out.push(b.items.join("; "));
  }
  return out;
}

/** The item's text as paragraphs: its blocks, its transcript, or at least its excerpt. */
export async function loadParagraphs(db: Db, store: ContentStore, itemId: string): Promise<string[]> {
  const [version] = await db
    .select({ blocksKey: contentVersion.blocksKey, excerpt: contentVersion.excerpt, transcriptKey: transcript.key })
    .from(contentVersion)
    .leftJoin(transcript, eq(transcript.itemVersionId, contentVersion.id))
    .where(eq(contentVersion.itemId, itemId))
    .orderBy(desc(contentVersion.fetchedAt))
    .limit(1);
  if (!version) return [];
  if (version.blocksKey) {
    const stored = await store.getJson<{ blocks: Block[] }>(version.blocksKey);
    if (stored) return blockParagraphs(stored.blocks);
  }
  if (version.transcriptKey) {
    const stored = await store.getJson<{ segments: TranscriptSegment[] }>(version.transcriptKey);
    if (stored) return transcriptParagraphs(stored.segments);
  }
  return version.excerpt ? [version.excerpt] : [];
}
