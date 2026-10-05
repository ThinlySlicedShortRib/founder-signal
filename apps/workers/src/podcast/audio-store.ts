import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Where finished episodes go, like copied images (letters/image-store.ts):
 * on AWS the images bucket under `podcast/`, served by its CloudFront
 * distribution at PODCAST_BASE_URL/<key>; locally a directory the local API
 * serves at /podcast/audio/<key>. An episode's key includes its ID, so a
 * file never changes once written.
 */
export interface AudioStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Where a key's file is on this machine (local store only), for the CLI's report. */
  pathOf?(key: string): string;
}

export const episodeAudioKey = (itemId: string, episodeId: string, ext: string) => `podcast/items/${itemId}/${episodeId}.${ext}`;

export function s3AudioStore(bucket: string, s3 = new S3Client({})): AudioStore {
  return {
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }));
    },
  };
}

export function fsAudioStore(dir: string): AudioStore {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(`${root}/`)) throw new Error(`Audio key escapes the store: ${key}`);
    return path;
  };
  return {
    pathOf,
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
  };
}

export function memoryAudioStore() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: AudioStore = {
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
  };
  return { store, objects };
}
