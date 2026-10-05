import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";

/**
 * Letter candidates (build plan §6.2), shared by the workers' collect step
 * and the API's "is there enough to pick from" check, so both use one rule.
 * The escalation rules themselves (which window, when to use the shared
 * pool) are in @fs/core letter-supply.ts.
 */

/**
 * What every candidate has to be, whichever way it was found: extracted,
 * titled, not a duplicate, not thin or SEO filler, from a publisher not
 * blocked globally or by this user and a source this user hasn't blocked,
 * not already in one of their letters (other than `letterId`) and not
 * reviewed by them. Videos only reach `extracted` with a transcript.
 */
function usable(userId: string, letterId: string | null) {
  return sql`ci.status in ('extracted', 'enriched') and ci.duplicate_of_id is null and ci.title is not null
    and coalesce(ci.quality_label, 'substantive') not in ('thin', 'seo_filler')
    and p.status <> 'blocked'
    and not exists (select 1 from user_publisher up where up.user_id = ${userId} and up.publisher_id = ci.publisher_id and up.blocked)
    and not exists (select 1 from user_source bs where bs.user_id = ${userId} and bs.source_id = ci.source_id and bs.blocked)
    and not exists (select 1 from letter_item li join letter l on l.id = li.letter_id
      where li.item_id = ci.id and l.user_id = ${userId} ${letterId ? sql`and l.id <> ${letterId}` : sql``})
    and not exists (select 1 from review r where r.item_id = ci.id and r.user_id = ${userId})`;
}

export interface CandidateWindow {
  /** Followed sources' and trusted feeds' items published (or, undated, added) within this many days. */
  followedDays: number;
  /** Pages discovery found for the user within this many days, whatever their publish date. */
  discoveredDays: number;
}

/**
 * The user's own candidates, newest first (a discovered page counts as new
 * when it was found):
 * - items from their followed, non-blocked sources;
 * - pages discovery found for them (a found page that turned out to be a
 *   duplicate counts as the original);
 * - items from trusted discovered publishers' feeds, for users discovery has
 *   shown that publisher to.
 */
export async function ownCandidateIds(
  db: Db,
  { userId, letterId = null, window, limit }: { userId: string; letterId?: string | null; window: CandidateWindow; limit: number },
): Promise<string[]> {
  const recent = sql`coalesce(ci.published_at, ci.created_at) > now() - make_interval(days => ${window.followedDays})`;
  const rows = await db.execute<{ id: string }>(sql`
    select ci.id from content_item ci join publisher p on p.id = ci.publisher_id
    where (
        (${recent} and exists (select 1 from user_source us where us.source_id = ci.source_id and us.user_id = ${userId} and not us.blocked))
        or exists (select 1 from user_discovery ud join content_item found on found.id = ud.item_id
          where ud.user_id = ${userId} and (found.id = ci.id or found.duplicate_of_id = ci.id)
            and ud.found_at > now() - make_interval(days => ${window.discoveredDays}))
        or (${recent} and p.origin = 'discovered' and p.status = 'trusted'
          and exists (select 1 from user_discovery ud join content_item found on found.id = ud.item_id
            where ud.user_id = ${userId} and found.publisher_id = ci.publisher_id)))
      and ${usable(userId, letterId)}
    order by greatest(coalesce(ci.published_at, ci.created_at),
      coalesce((select max(ud.found_at) from user_discovery ud where ud.user_id = ${userId} and ud.item_id = ci.id), '-infinity'::timestamptz)) desc, ci.id
    limit ${limit}`);
  return [...new Set(rows.rows.map((r) => r.id))];
}

/** A shared-pool item, with what's needed to match it to a brief and rank it. */
export interface PoolCandidateRow {
  itemId: string;
  kind: "article" | "video";
  title: string;
  tags: string[];
  excerpt: string | null;
  publisherId: string;
  publisherName: string;
  authorKey: string | null;
  publishedAt: Date | null;
  quality: string | null;
  depth: string | null;
  readTimeMinutes: number | null;
  durationSeconds: number | null;
}

/**
 * The shared pool (§6.2): good items found for someone else. Pages other
 * users' discovery found, and items from trusted publishers, published or
 * found within `windowDays`; only substantive or not-yet-labelled ones, and
 * everything `usable` asks of the user's own candidates. Newest first, not
 * yet matched to the user's brief (that's @fs/core `sharedPoolMatches`).
 */
export async function sharedPoolRows(
  db: Db,
  { userId, letterId = null, windowDays, limit, exclude = [] }: { userId: string; letterId?: string | null; windowDays: number; limit: number; exclude?: string[] },
): Promise<PoolCandidateRow[]> {
  const excluded = exclude.length ? sql`and ci.id not in (${sql.join(exclude.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const rows = await db.execute<{
    id: string;
    type: "article" | "video";
    title: string;
    tags: string[] | null;
    excerpt: string | null;
    publisher_id: string;
    publisher_name: string;
    author_key: string | null;
    published_at: string | Date | null;
    quality_label: string | null;
    depth: string | null;
    read_time_minutes: number | null;
    duration_seconds: number | null;
  }>(sql`
    select ci.id, ci.type, ci.title, ci.tags, ci.publisher_id, p.name as publisher_name, ci.author_key, ci.published_at,
      ci.quality_label, ci.depth, ci.read_time_minutes, ci.duration_seconds,
      (select cv.excerpt from content_version cv where cv.item_id = ci.id order by cv.fetched_at desc limit 1) as excerpt
    from content_item ci join publisher p on p.id = ci.publisher_id
    where (ci.quality_label is null or ci.quality_label = 'substantive')
      and (
        (p.status = 'trusted' and coalesce(ci.published_at, ci.created_at) > now() - make_interval(days => ${windowDays}))
        or exists (select 1 from user_discovery ud join content_item found on found.id = ud.item_id
          where ud.user_id <> ${userId} and (found.id = ci.id or found.duplicate_of_id = ci.id)
            and ud.found_at > now() - make_interval(days => ${windowDays})))
      and ${usable(userId, letterId)}
      ${excluded}
    order by coalesce(ci.published_at, ci.created_at) desc, ci.id
    limit ${limit}`);
  return rows.rows.map((r) => ({
    itemId: r.id,
    kind: r.type,
    title: r.title,
    tags: r.tags ?? [],
    excerpt: r.excerpt,
    publisherId: r.publisher_id,
    publisherName: r.publisher_name,
    authorKey: r.author_key,
    publishedAt: r.published_at ? new Date(r.published_at) : null,
    quality: r.quality_label,
    depth: r.depth,
    readTimeMinutes: r.read_time_minutes,
    durationSeconds: r.duration_seconds,
  }));
}

/** The brief a shared-pool item is matched against: the user's topics, "lately", and the leanings they chose last. */
export async function loadPoolBrief(db: Db, userId: string): Promise<{ topics: { topic: string; weight: number }[]; lately: string | null; leanings: string[] }> {
  const [topics, lately, leanings] = await Promise.all([
    db.execute<{ topic: string; weight: number }>(sql`select topic, weight from topic_weight where user_id = ${userId}`),
    db.execute<{ lately: string | null }>(sql`select lately from profile where user_id = ${userId}`),
    db.execute<{ chosen_leanings: string[] }>(sql`
      select chosen_leanings from letter where user_id = ${userId} and delivered_at is not null order by delivered_at desc limit 1`),
  ]);
  return {
    topics: topics.rows.map((t) => ({ topic: t.topic, weight: Number(t.weight) })),
    lately: lately.rows[0]?.lately ?? null,
    leanings: leanings.rows[0]?.chosen_leanings ?? [],
  };
}
