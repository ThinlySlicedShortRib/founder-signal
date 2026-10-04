import type { FetchResult } from "@fs/ingest";
import { describe, expect, it } from "vitest";
import { copyingImageStore, imageKey, memoryImageObjects } from "../src/letters/image-store.ts";

function world(pages: Record<string, { status?: number; contentType: string; bytes?: Uint8Array }>) {
  const fetched: string[] = [];
  const { store, objects } = memoryImageObjects();
  const images = copyingImageStore({
    objects: store,
    baseUrl: "https://images.example.com/",
    async fetch(url, options): Promise<FetchResult> {
      fetched.push(url);
      expect(options?.as).toBe("bytes");
      const page = pages[url];
      if (!page) throw new Error("network down");
      return { status: page.status ?? 200, url, contentType: page.contentType, headers: new Headers(), body: "", bytes: page.bytes ?? new Uint8Array([1, 2, 3]) };
    },
  });
  return { images, objects, fetched };
}

describe("copyingImageStore", () => {
  it("copies an image once and serves it from the base URL", async () => {
    const w = world({ "https://a.test/lead.jpg": { contentType: "image/jpeg; charset=binary" } });
    const url = await w.images.copy("item-1", "https://a.test/lead.jpg");
    const key = imageKey("item-1", "https://a.test/lead.jpg", "jpg");
    expect(url).toBe(`https://images.example.com/${key}`);
    expect(w.objects.get(key)?.contentType).toBe("image/jpeg");

    expect(await w.images.copy("item-1", "https://a.test/lead.jpg")).toBe(url);
    expect(w.fetched).toHaveLength(1);
  });

  it("returns null for anything that isn't a usable image", async () => {
    const w = world({
      "https://a.test/page": { contentType: "text/html" },
      "https://a.test/svg": { contentType: "image/svg+xml" },
      "https://a.test/gone.jpg": { status: 404, contentType: "image/jpeg" },
      "https://a.test/empty.png": { contentType: "image/png", bytes: new Uint8Array() },
    });
    for (const u of ["https://a.test/page", "https://a.test/svg", "https://a.test/gone.jpg", "https://a.test/empty.png", "https://a.test/down.jpg"]) {
      expect(await w.images.copy("item-2", u)).toBeNull();
    }
    expect(w.objects.size).toBe(0);
  });
});
