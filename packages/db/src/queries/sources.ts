import { sql } from "drizzle-orm";
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

/**
 * Upserts the shared publisher and source and links the source to the user.
 * The source is due for fetching immediately. Returns the source ID.
 */
export async function addUserSource(
  db: Db,
  { userId, mode, detected }: { userId: string; mode: "more_like_this" | "follow_closely" | "occasional"; detected: NewSource },
): Promise<string> {
  return db.transaction(async (tx) => {
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

    await tx
      .insert(userSource)
      .values({ userId, sourceId: src!.id, mode })
      .onConflictDoUpdate({ target: [userSource.userId, userSource.sourceId], set: { mode, blocked: false } });

    return src!.id;
  });
}
