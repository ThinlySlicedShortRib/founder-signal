import type { ReaderWriter } from "@fs/ai";
import { fallbackRecap, initialsFor, verdictSignature } from "@fs/core";
import { type Db, schema } from "@fs/db";
import type { AuthorCard, LetterPiece, LetterStatus, LetterView, Postscript, ReviewVote } from "@fs/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

const { author, contentItem, interaction, letter, letterItem, review, schedule, userAuthor } = schema;

export type LetterRow = typeof letter.$inferSelect;

/** The pieces' user state: verdicts from reviews, the rest from the latest relevant event. */
export async function pieceStates(db: Db, userId: string, itemIds: string[]) {
  const out = new Map<string, { verdict: ReviewVote | null; reasons: string[]; skipped: boolean; completed: boolean; saved: boolean }>();
  if (!itemIds.length) return out;
  const [reviews, events] = await Promise.all([
    db
      .select({ itemId: review.itemId, vote: review.vote, reasons: review.reasons })
      .from(review)
      .where(and(eq(review.userId, userId), inArray(review.itemId, itemIds))),
    // The latest event of each kind per item: complete/uncomplete, save/unsave, skip.
    db.execute<{ item_id: string; kind: string; type: string }>(sql`
      select distinct on (item_id, kind) item_id, kind, type from (
        select item_id, type, occurred_at,
          case when type in ('complete', 'uncomplete') then 'complete'
               when type in ('save', 'unsave') then 'save'
               else type::text end as kind
        from ${interaction}
        where user_id = ${userId} and item_id in (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and type in ('complete', 'uncomplete', 'save', 'unsave', 'skip')
      ) e
      order by item_id, kind, occurred_at desc`),
  ]);
  for (const id of itemIds) out.set(id, { verdict: null, reasons: [], skipped: false, completed: false, saved: false });
  for (const r of reviews) Object.assign(out.get(r.itemId)!, { verdict: r.vote, reasons: r.reasons });
  for (const e of events.rows) {
    const s = out.get(e.item_id)!;
    if (e.kind === "complete") s.completed = e.type === "complete";
    else if (e.kind === "save") s.saved = e.type === "save";
    else if (e.kind === "skip") s.skipped = true;
  }
  return out;
}

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Author cards for these keys: the shared details, the user's follow, and other pieces of theirs the user read or saved. */
export async function authorCards(db: Db, userId: string, keys: { key: string; name: string; itemId: string }[]): Promise<Map<string, AuthorCard>> {
  const cards = new Map<string, AuthorCard>();
  const distinct = [...new Set(keys.map((k) => k.key))];
  if (!distinct.length) return cards;
  const [rows, follows, reading] = await Promise.all([
    db.select().from(author).where(inArray(author.key, distinct)),
    db
      .select({ key: author.key })
      .from(userAuthor)
      .innerJoin(author, eq(author.id, userAuthor.authorId))
      .where(and(eq(userAuthor.userId, userId), inArray(author.key, distinct))),
    db.execute<{ author_key: string; item_id: string; title: string; type: string; occurred_at: Date }>(sql`
      select distinct on (ci.id) ci.author_key, ci.id as item_id, ci.title, e.type, e.occurred_at
      from ${interaction} e join ${contentItem} ci on ci.id = e.item_id
      where e.user_id = ${userId} and e.type in ('complete', 'save')
        and ci.author_key in (${sql.join(distinct.map((k) => sql`${k}`), sql`, `)}) and ci.title is not null
      order by ci.id, e.occurred_at desc`),
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const followed = new Set(follows.map((f) => f.key));
  for (const { key, name, itemId } of keys) {
    if (cards.has(`${key}|${itemId}`)) continue;
    const a = byKey.get(key);
    const yourReading = reading.rows
      .filter((r) => r.author_key === key && r.item_id !== itemId)
      .sort((x, y) => new Date(y.occurred_at).getTime() - new Date(x.occurred_at).getTime())
      .slice(0, 5)
      .map((r) => ({ itemId: r.item_id, title: r.title, note: `${r.type === "save" ? "Saved" : "Read"} ${shortDate(new Date(r.occurred_at))}` }));
    const enriched = a?.enrichmentStatus === "enriched";
    cards.set(`${key}|${itemId}`, {
      key,
      name: a?.name ?? name,
      initials: a?.initials ?? initialsFor(name),
      role: enriched ? a!.role : null,
      headline: enriched ? a!.headline : null,
      short: enriched ? a!.short : null,
      bio: enriched ? a!.bio : null,
      stats: enriched ? a!.stats.slice(0, 3).map((s) => ({ value: s.value, label: s.label })) : [],
      knownFor: enriched ? a!.knownFor.slice(0, 4) : [],
      siteUrl: enriched ? a!.siteUrl : null,
      provenance: enriched ? a!.provenance : null,
      yourReading,
      following: followed.has(key),
    });
  }
  return cards;
}

export async function nextLetterAt(db: Db, userId: string): Promise<string | null> {
  const [s] = await db.select({ next: schedule.nextRunAt, paused: schedule.paused }).from(schedule).where(eq(schedule.userId, userId));
  return s && !s.paused ? (s.next?.toISOString() ?? null) : null;
}

/** "Letter No. n": the letter's number once delivered, else the number it will get. */
async function displayNumber(db: Db, l: LetterRow): Promise<number> {
  if (l.number) return l.number;
  const [row] = await db
    .select({ n: sql<number>`coalesce(max(${letter.number}), 0)::int` })
    .from(letter)
    .where(eq(letter.userId, l.userId));
  return (row?.n ?? 0) + 1;
}

const publicStatus = (s: LetterRow["status"]): LetterStatus => (s === "skipped" ? "skipped_no_candidates" : s);

/**
 * The P.S. recap (one or two sentences on the pieces marked worth it). It's
 * rewritten lazily, here, whenever the verdicts it was written from change;
 * null until something is marked worth it.
 */
async function recapFor(
  db: Db,
  reader: ReaderWriter | null,
  l: LetterRow,
  pieces: { itemId: string; title: string; summary: string; verdict: ReviewVote | null; reasons: string[] }[],
): Promise<string | null> {
  const worth = pieces.filter((p) => p.verdict === "interested");
  if (!worth.length) return null;
  const signature = verdictSignature(worth.map((p) => ({ itemId: p.itemId, vote: "interested", reasons: p.reasons })));
  if (l.postscriptRecap && l.postscriptRecapSignature === signature) return l.postscriptRecap;

  let recap: string | null = null;
  if (reader) {
    try {
      recap = (await reader.recap({ pieces: worth.map((p) => ({ title: p.title, summary: p.summary, reasons: p.reasons })) })).slice(0, 400) || null;
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", message: "recap fell back to the plain one", error: (err as Error).message }));
    }
  }
  recap ??= fallbackRecap(worth.map((p) => ({ title: p.title, reasons: p.reasons })));
  await db.update(letter).set({ postscriptRecap: recap, postscriptRecapSignature: signature }).where(eq(letter.id, l.id));
  return recap;
}

export async function postscriptFor(db: Db, l: LetterRow, recap: string | null): Promise<Postscript> {
  return { recap, nextLetterAt: await nextLetterAt(db, l.userId), leanings: l.leanings.slice(0, 6), chosenLeanings: l.chosenLeanings.slice(0, 10) };
}

export async function buildLetterView(db: Db, reader: ReaderWriter | null, l: LetterRow): Promise<LetterView> {
  const items = await db
    .select({ itemId: letterItem.itemId, position: letterItem.position, feedbackCode: letterItem.feedbackCode, snapshot: letterItem.snapshot })
    .from(letterItem)
    .where(eq(letterItem.letterId, l.id))
    .orderBy(letterItem.position);
  const ids = items.map((i) => i.itemId);
  const [states, cards] = await Promise.all([
    pieceStates(db, l.userId, ids),
    authorCards(
      db,
      l.userId,
      items.filter((i) => i.snapshot.author).map((i) => ({ key: i.snapshot.author!.key, name: i.snapshot.author!.name, itemId: i.itemId })),
    ),
  ]);

  const pieces: LetterPiece[] = items.map((i) => {
    const s = i.snapshot;
    const state = states.get(i.itemId)!;
    return {
      itemId: i.itemId,
      position: i.position,
      kind: s.kind,
      title: s.title,
      topic: s.topic,
      minutes: Math.max(1, s.minutes),
      whyPicked: s.whyPicked,
      tag: s.tag,
      summary: s.summary,
      sourceName: s.sourceName,
      originalUrl: s.originalUrl,
      image: s.image,
      author: s.author ? (cards.get(`${s.author.key}|${i.itemId}`) ?? null) : null,
      feedbackCode: i.feedbackCode,
      verdict: state.verdict,
      skipped: state.skipped,
      completed: state.completed,
      saved: state.saved,
    };
  });

  const recap = await recapFor(
    db,
    reader,
    l,
    items.map((i) => ({ itemId: i.itemId, title: i.snapshot.title, summary: i.snapshot.summary, ...states.get(i.itemId)! })),
  );

  return {
    id: l.id,
    number: await displayNumber(db, l),
    status: publicStatus(l.status),
    deliveredAt: l.deliveredAt?.toISOString() ?? null,
    localDate: l.localDate,
    headline: l.headline ?? "",
    intro: l.intro ?? "",
    totalMinutes: pieces.reduce((n, p) => n + p.minutes, 0),
    whyThisMix: l.whyThisMix,
    pieces,
    postscript: await postscriptFor(db, l, recap),
    isTest: l.isTest,
  };
}

/** The user's most recent delivered letter (test letters included). */
export async function latestDelivered(db: Db, userId: string): Promise<LetterRow | null> {
  const [row] = await db
    .select()
    .from(letter)
    .where(and(eq(letter.userId, userId), isNotNull(letter.deliveredAt), ne(letter.status, "skipped")))
    .orderBy(desc(letter.deliveredAt), desc(letter.id))
    .limit(1);
  return row ?? null;
}
