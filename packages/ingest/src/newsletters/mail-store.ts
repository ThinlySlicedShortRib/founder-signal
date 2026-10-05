import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Where raw inbound email waits until it's processed: the SES mail bucket on
 * AWS (SES writes it; the worker only reads and deletes), a directory locally.
 */
export interface RawMailStore {
  put(key: string, raw: Uint8Array): Promise<void>;
  /** Null when there's no such message. `tooLarge` when it's over `maxBytes` (it isn't read). */
  get(key: string, opts: { maxBytes: number }): Promise<Uint8Array | "tooLarge" | null>;
  delete(key: string): Promise<void>;
}

export function s3RawMailStore(bucket: string): RawMailStore {
  const s3 = new S3Client({});
  return {
    async put(key, raw) {
      // SES writes on AWS; this is only for completeness (and the bucket's default encryption applies).
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: raw, ContentType: "message/rfc822" }));
    },
    async get(key, { maxBytes }) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if ((res.ContentLength ?? 0) > maxBytes) {
          res.Body?.transformToWebStream().cancel().catch(() => {});
          return "tooLarge";
        }
        return await res.Body!.transformToByteArray();
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function fsRawMailStore(dir: string): RawMailStore {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(`${root}/`)) throw new Error(`Mail key escapes the store: ${key}`);
    return path;
  };
  return {
    async put(key, raw) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw);
    },
    async get(key, { maxBytes }) {
      try {
        const raw = await readFile(pathFor(key));
        return raw.byteLength > maxBytes ? "tooLarge" : new Uint8Array(raw);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export function memoryRawMailStore() {
  const objects = new Map<string, Uint8Array>();
  const store: RawMailStore = {
    async put(key, raw) {
      objects.set(key, raw);
    },
    async get(key, { maxBytes }) {
      const raw = objects.get(key);
      if (!raw) return null;
      return raw.byteLength > maxBytes ? "tooLarge" : raw;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { store, objects };
}
