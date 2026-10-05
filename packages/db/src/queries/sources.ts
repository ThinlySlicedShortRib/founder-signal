import { inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { publisher, source, userSource } from "../schema/ingestion.ts";

export interface NewSource {
  type: "feed" | "url" | "youtube_channel";
  canonicalKey: string;
  inputUrl: string;
  fetchUrl: string;
  title: string;
  creator: string | null;
  publisher: { key: string; name: string; feedUrl: string | null };
}

type SourceMode = "more_like_this" | "follow_closely" | "occasional";

/**
 * Upserts the shared publisher and source and links the source to the user.
 * The source is due for fetching immediately. Returns the source ID.
 */
export async function addUserSource(
  db: Db,
  { userId, mode, detected }: { userId: string; mode: SourceMode; detected: NewSource },
): Promise<string> {
  return db.transaction(async (tx) => {
    const sourceId = await upsertSource(tx, detected);
    await tx
      .insert(userSource)
      .values({ userId, sourceId, mode })
      .onConflictDoUpdate({ target: [userSource.userId, userSource.sourceId], set: { mode, blocked: false } });
    return sourceId;
  });
}

/**
 * Adds a source found by an import (docs/imports/README.md). Like
 * addUserSource, but a source the user already has is left exactly as it is
 * (mode, pause), and the link records the import. A feed already known under
 * the other scheme or with/without `www.` is reused rather than duplicated.
 * `added` is false when the user already had it.
 */
export async function addImportedSource(
  db: Db,
  { userId, mode, detected, importId }: { userId: string; mode: SourceMode; detected: NewSource; importId: string },
): Promise<{ sourceId: string; added: boolean }> {
  return db.transaction(async (tx) => {
    let target = detected;
    if (detected.type === "feed") {
      const [existing] = await tx
        .select({ key: source.canonicalKey })
        .from(source)
        .where(inArray(source.canonicalKey, urlVariants(detected.canonicalKey)))
        .limit(1);
      if (existing) target = { ...detected, canonicalKey: existing.key };
    }
    const sourceId = await upsertSource(tx, target);
    const inserted = await tx
      .insert(userSource)
      .values({ userId, sourceId, mode, importId })
      .onConflictDoNothing({ target: [userSource.userId, userSource.sourceId] })
      .returning({ id: userSource.id });
    return { sourceId, added: inserted.length > 0 };
  });
}

/** The same URL with http/https and with/without `www.`: feeds people export are often the other form. */
export function urlVariants(key: string): string[] {
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return [key];
  }
  const out = new Set<string>([key]);
  for (const protocol of ["https:", "http:"]) {
    for (const www of [true, false]) {
      const v = new URL(url);
      v.protocol = protocol;
      const bare = v.hostname.replace(/^www\./, "");
      v.hostname = www ? `www.${bare}` : bare;
      out.add(v.toString());
    }
  }
  return [...out];
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Upserts the shared publisher and source; the source is due for fetching immediately. Returns the source ID. */
async function upsertSource(tx: Tx, detected: NewSource): Promise<string> {
  const [pub] = await tx
    .insert(publisher)
    .values({
      key: detected.publisher.key,
      name: detected.publisher.name,
      feedUrl: detected.publisher.feedUrl,
      origin: "user_added",
    })
    .onConflictDoUpdate({
      target: publisher.key,
      // Keep the name we have; learn the feed if we didn't know it.
      set: { feedUrl: sql`coalesce(${publisher.feedUrl}, excluded.feed_url)` },
    })
    .returning({ id: publisher.id });

  const revive = sql`${source.type} <> 'url' and ${source.nextFetchAt} is null`;
  const [src] = await tx
    .insert(source)
    .values({
      canonicalKey: detected.canonicalKey,
      type: detected.type,
      publisherId: pub!.id,
      title: detected.title,
      creator: detected.creator,
      inputUrl: detected.inputUrl,
      fetchUrl: detected.fetchUrl,
      nextFetchAt: new Date(),
    })
    .onConflictDoUpdate({
      target: source.canonicalKey,
      // Re-adding a feed that was given up on (too many failures) revives it.
      set: {
        nextFetchAt: sql`case when ${revive} then now() else ${source.nextFetchAt} end`,
        consecutiveFailures: sql`case when ${revive} then 0 else ${source.consecutiveFailures} end`,
      },
    })
    .returning({ id: source.id });
  return src!.id;
}
