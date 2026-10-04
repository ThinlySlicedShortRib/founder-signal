import { createHash } from "node:crypto";
import { type Db, schema } from "@fs/db";
import type { PieceImage } from "@fs/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ImageStore } from "./image-store.ts";

const { stockPhoto } = schema;

/**
 * The picture behind a piece: the article's own lead image, else a stock
 * photo for its topic from Unsplash, else none. Unsplash's API guidelines
 * apply: hotlink images.unsplash.com URLs as returned, credit the
 * photographer with a link (with UTM parameters), and call the photo's
 * download endpoint each time it's used.
 */

export interface StockPhotos {
  /** A photo for the topic; `seed` picks among the cached results so letters vary. */
  forTopic(topic: string, seed: string): Promise<PieceImage | null>;
}

/** Cached results are refreshed after this long. */
const CACHE_DAYS = 30;
const APP_NAME = "founder_signal";

const searchSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      urls: z.object({ regular: z.string() }),
      links: z.object({ download_location: z.string() }),
      user: z.object({ name: z.string(), links: z.object({ html: z.string() }) }),
    }),
  ),
});

export function unsplashStockPhotos({
  accessKey,
  db,
  fetch = globalThis.fetch,
  log = () => {},
}: {
  accessKey: string;
  db: Db;
  fetch?: typeof globalThis.fetch;
  log?: (event: string, data?: Record<string, unknown>) => void;
}): StockPhotos {
  const headers = { authorization: `Client-ID ${accessKey}`, "accept-version": "v1" };

  async function photosFor(topic: string) {
    const [cached] = await db.select().from(stockPhoto).where(eq(stockPhoto.topic, topic));
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_DAYS * 86_400_000) return cached.photos;

    const qs = new URLSearchParams({ query: topic, orientation: "landscape", per_page: "10", content_filter: "high" });
    const res = await fetch(`https://api.unsplash.com/search/photos?${qs}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log("unsplash_error", { status: res.status, topic });
      return cached?.photos ?? [];
    }
    const body = searchSchema.parse(await res.json());
    const utm = `utm_source=${APP_NAME}&utm_medium=referral`;
    const photos = body.results
      .filter((r) => r.urls.regular.startsWith("https://images.unsplash.com/"))
      .map((r) => ({
        id: r.id,
        url: r.urls.regular,
        credit: `${r.user.name} on Unsplash`,
        creditUrl: `${r.user.links.html}${r.user.links.html.includes("?") ? "&" : "?"}${utm}`,
        downloadLocation: r.links.download_location,
      }));
    await db
      .insert(stockPhoto)
      .values({ topic, provider: "unsplash", photos, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: stockPhoto.topic, set: { photos, fetchedAt: new Date() } });
    return photos;
  }

  return {
    async forTopic(rawTopic, seed) {
      const topic = rawTopic.trim().toLowerCase();
      if (!topic) return null;
      try {
        const photos = await photosFor(topic);
        if (!photos.length) return null;
        const index = createHash("sha256").update(seed).digest().readUInt32BE(0) % photos.length;
        const photo = photos[index]!;
        // Required by the API guidelines whenever a photo is used.
        await fetch(photo.downloadLocation, { headers, signal: AbortSignal.timeout(5_000) }).catch((err) =>
          log("unsplash_download_failed", { id: photo.id, message: (err as Error).message }),
        );
        return { url: photo.url, source: "stock", credit: photo.credit, creditUrl: photo.creditUrl };
      } catch (err) {
        // A missing picture never holds up a letter.
        log("unsplash_failed", { topic, message: (err as Error).message });
        return null;
      }
    },
  };
}

/**
 * The article's own image when it has one (our copy when the store has one,
 * else the publisher's URL), else stock for the topic, else none.
 */
export async function pieceImage(
  { stock, images }: { stock: StockPhotos | null; images: ImageStore | null },
  item: { id: string; leadImageUrl: string | null },
  topic: string,
): Promise<PieceImage | null> {
  if (item.leadImageUrl && z.url().safeParse(item.leadImageUrl).success) {
    const url = (await images?.copy(item.id, item.leadImageUrl)) ?? item.leadImageUrl;
    return { url, source: "article", credit: null, creditUrl: null };
  }
  return stock ? stock.forTopic(topic, item.id) : null;
}
