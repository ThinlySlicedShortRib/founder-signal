import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Where permitted block JSON and transcripts live (build plan §2: S3 content bucket). */
export interface ContentStore {
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T = unknown>(key: string): Promise<T | null>;
}

export const contentKeys = {
  blocks: (itemId: string, contentHash: string) => `items/${itemId}/blocks-${contentHash}.json`,
  transcript: (itemId: string, contentHash: string) => `items/${itemId}/transcript-${contentHash}.json`,
};

export function s3ContentStore(bucket: string): ContentStore {
  const s3 = new S3Client({});
  return {
    async putJson(key, value) {
      // The bucket's default encryption (KMS) applies.
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json" }),
      );
    },
    async getJson(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await res.Body!.transformToString());
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
  };
}

export function fsContentStore(dir: string): ContentStore {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(`${root}/`)) throw new Error(`Content key escapes the store: ${key}`);
    return path;
  };
  return {
    async putJson(key, value) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    },
    async getJson(key) {
      try {
        return JSON.parse(await readFile(pathFor(key), "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

export function memoryContentStore() {
  const objects = new Map<string, string>();
  const store: ContentStore = {
    async putJson(key, value) {
      objects.set(key, JSON.stringify(value));
    },
    async getJson(key) {
      const v = objects.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
  };
  return { store, objects };
}
