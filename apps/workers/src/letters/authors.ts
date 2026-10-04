import { AUTHOR_PROMPT_VERSION } from "@fs/ai";
import { AUTHOR_RECHECK_DAYS, provenanceLine } from "@fs/core";
import { schema } from "@fs/db";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { logger, type PipelineDeps } from "../pipeline/deps.ts";
import type { Message } from "../pipeline/messages.ts";

const { author, contentItem, publisher } = schema;

/** Another worker's enrichment of the same author is assumed alive this long. */
const ENRICH_LEASE_MINUTES = 15;
const MAX_ATTEMPTS = 3;

/**
 * Fills in an author card once (and again after ~90 days) with Claude and web
 * search. Only sourced facts are stored, with where they came from. Nothing
 * reliable → `not_found`, and the card stays just the name.
 */
export async function enrichAuthor(deps: PipelineDeps, { authorKey }: Message<"author">) {
  const { db } = deps;
  const log = logger(deps);
  if (!deps.authorEnricher) return { status: "disabled" as const };

  const [claimed] = await db
    .update(author)
    .set({ enrichmentStartedAt: sql`now()`, enrichmentAttempts: sql`${author.enrichmentAttempts} + 1` })
    .where(
      and(
        eq(author.key, authorKey),
        or(isNull(author.checkedAt), lt(author.checkedAt, sql`now() - make_interval(days => ${AUTHOR_RECHECK_DAYS})`)),
        or(isNull(author.enrichmentStartedAt), lt(author.enrichmentStartedAt, sql`now() - make_interval(mins => ${ENRICH_LEASE_MINUTES})`)),
      ),
    )
    .returning();
  if (!claimed) return { status: "skipped" as const };

  const items = await db
    .select({ title: contentItem.title, publisherName: publisher.name, publisherKey: publisher.key, url: contentItem.canonicalUrl })
    .from(contentItem)
    .innerJoin(publisher, eq(publisher.id, contentItem.publisherId))
    .where(eq(contentItem.authorKey, authorKey))
    .orderBy(desc(contentItem.publishedAt))
    .limit(5);
  const isChannel = authorKey.startsWith("youtube:");
  const first = items[0];
  const query = {
    name: claimed.name,
    publication: first?.publisherName ?? claimed.name,
    publicationUrl: isChannel ? claimed.followUrl : first ? new URL(first.url).origin : null,
    titles: items.map((i) => i.title).filter((t): t is string => !!t),
    isChannel,
  };

  let findings;
  try {
    findings = await deps.authorEnricher.enrich(query);
  } catch (err) {
    const giveUp = claimed.enrichmentAttempts >= MAX_ATTEMPTS;
    await db
      .update(author)
      .set(giveUp ? { enrichmentStatus: "failed", checkedAt: new Date(), enrichmentStartedAt: null } : { enrichmentStartedAt: null })
      .where(eq(author.id, claimed.id));
    log("author_enrich_failed", { authorKey, attempts: claimed.enrichmentAttempts, message: (err as Error).message });
    if (giveUp) return { status: "failed" as const };
    throw err;
  }

  const now = new Date();
  const base = { checkedAt: now, enrichmentStartedAt: null, enrichmentMethod: `${deps.authorEnricher.method}:${AUTHOR_PROMPT_VERSION}` };
  if (!findings) {
    await db.update(author).set({ ...base, enrichmentStatus: "not_found" }).where(eq(author.id, claimed.id));
    return { status: "not_found" as const };
  }
  await db
    .update(author)
    .set({
      ...base,
      enrichmentStatus: "enriched",
      role: findings.role,
      headline: findings.headline,
      short: findings.short,
      bio: findings.bio,
      stats: findings.stats,
      knownFor: findings.knownFor,
      siteUrl: findings.siteUrl,
      // A channel is followed as itself; a writer through their own feed or site, when found.
      followUrl: isChannel ? claimed.followUrl : (findings.followUrl ?? findings.siteUrl),
      sources: findings.sources,
      provenance: provenanceLine(findings.sources, now),
    })
    .where(eq(author.id, claimed.id));
  return { status: "enriched" as const, stats: findings.stats.length };
}
