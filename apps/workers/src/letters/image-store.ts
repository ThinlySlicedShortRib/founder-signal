import { createHash } from "node:crypto";
import { HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Fetcher } from "@fs/ingest";

/**
 * Copies of articles' lead images, so a letter's pictures don't depend on
 * the publisher's hotlink staying up. A copy is made once per item and image
 * URL; stock photos are never copied (Unsplash requires hotlinking).
 */
export interface ImageStore {
  /** The copy's URL, or null when the image can't be copied (the caller hotlinks instead). */
  copy(itemId: string, sourceUrl: string): Promise<string | null>;
}

/** Where copies are written. */
export interface ImageObjects {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const imageKey = (itemId: string, sourceUrl: string, ext: string) =>
  `images/items/${itemId}/${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}.${ext}`;

export function copyingImageStore({
  objects,
  baseUrl,
  fetch,
  log = () => {},
}: {
  objects: ImageObjects;
  /** Copies are served at `${baseUrl}/${key}`. */
  baseUrl: string;
  /** The SSRF-safe fetcher: lead image URLs come from arbitrary pages. */
  fetch: Fetcher;
  log?: (event: string, data?: Record<string, unknown>) => void;
}): ImageStore {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async copy(itemId, sourceUrl) {
      try {
        // A copy made for an earlier letter is reused; the extension is unknown until fetched, so try each.
        for (const ext of new Set(Object.values(TYPES))) {
          const key = imageKey(itemId, sourceUrl, ext);
          if (await objects.exists(key)) return `${base}/${key}`;
        }
        const res = await fetch(sourceUrl, { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9", as: "bytes" });
        const type = res.contentType.split(";")[0]!.trim().toLowerCase();
        const ext = TYPES[type];
        if (res.status !== 200 || !ext || !res.bytes?.byteLength) {
          log("image_copy_skipped", { itemId, status: res.status, contentType: type });
          return null;
        }
        const key = imageKey(itemId, sourceUrl, ext);
        await objects.put(key, res.bytes, type);
        return `${base}/${key}`;
      } catch (err) {
        // A missing copy never holds up a letter.
        log("image_copy_failed", { itemId, message: (err as Error).message });
        return null;
      }
    },
  };
}

export function s3ImageObjects(bucket: string, s3 = new S3Client({})): ImageObjects {
  return {
    async exists(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if (err instanceof NotFound) return false;
        throw err;
      }
    },
    async put(key, body, contentType) {
      // Keys change whenever the source URL does, so a copy never changes.
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }),
      );
    },
  };
}

export function memoryImageObjects() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: ImageObjects = {
    async exists(key) {
      return objects.has(key);
    },
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
  };
  return { store, objects };
}
