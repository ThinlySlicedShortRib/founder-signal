import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@fs/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PodcastConfig } from "../src/lib/podcast.ts";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const { contentItem, contentVersion, episode, publisher } = schema;

const queued: string[] = [];
const podcast: PodcastConfig = {
  format: "conversation",
  promptVersion: "podcast-script-v1",
  voiceKey: "kokoro-v1.0:af_heart+am_michael",
  queue: { start: async (id) => void queued.push(id) },
  audioUrl: (key) => `/podcast/audio/${key}`,
};

let dir: string;
let ctx: ReturnType<typeof createTestApp>;
let off: ReturnType<typeof createTestApp>;
let cookie: string;
let offCookie: string;

async function seedItem(display: "full_text" | "excerpt_only" = "full_text") {
  const [pub] = await ctx.db.insert(publisher).values({ key: `pub-${randomUUID()}`, name: "Blog", origin: "user_added" }).returning();
  const [item] = await ctx.db
    .insert(contentItem)
    .values({ canonicalUrl: `https://example.com/${randomUUID()}`, type: "article", publisherId: pub!.id, title: "A piece", status: "extracted" })
    .returning();
  await ctx.db
    .insert(contentVersion)
    .values({ itemId: item!.id, contentHash: "h", blocksKey: `items/${item!.id}/b.json`, sectionMap: [], rightsSnapshot: { display, retainText: true, offlineAllowed: true, licenseNote: null } });
  return item!.id;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-podcast-api-"));
  ctx = createTestApp({ podcast, podcastDir: dir });
  off = createTestApp();
  cookie = await signIn(ctx, "podcast@example.com");
  offCookie = await signIn(off, "podcast-off@example.com");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await ctx.pool.end();
  await off.pool.end();
});

const get = (id: string, c = cookie, app = ctx) => app.app.request(`${BASE_URL}/items/${id}/episode`, { headers: { cookie: c } });
const post = (id: string) => ctx.app.request(`${BASE_URL}/items/${id}/episode`, { method: "POST", headers: { cookie, origin: BASE_URL } });

describe("/items/:id/episode", () => {
  it("has none until asked, then queues one once and shares it", async () => {
    const id = await seedItem();
    expect(await (await get(id)).json()).toEqual({ episode: null, available: true });

    const first = await post(id);
    expect(first.status).toBe(202);
    const { episode: made } = (await first.json()) as { episode: { id: string } };
    expect(made).toMatchObject({ status: "queued", format: "conversation", audioUrl: null, chapters: [] });
    expect(queued).toContain(made.id);

    const again = await post(id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { episode: { id: string } }).episode.id).toBe(made.id);
    expect(queued.filter((q) => q === made.id)).toHaveLength(1);

    // The workers finish it.
    await ctx.db
      .update(episode)
      .set({ status: "ready", audioKey: `podcast/items/${id}/${made.id}.m4a`, durationSeconds: 61.5, chapters: [{ title: "Opening", startSeconds: 0 }] })
      .where(eq(episode.id, made.id));
    expect(((await (await get(id)).json()) as { episode: unknown }).episode).toEqual({
      id: made.id,
      status: "ready",
      format: "conversation",
      audioUrl: `/podcast/audio/podcast/items/${id}/${made.id}.m4a`,
      durationSeconds: 61.5,
      chapters: [{ title: "Opening", startSeconds: 0 }],
    });
  });

  it("refuses pieces the app can't show in full, and unknown items", async () => {
    const id = await seedItem("excerpt_only");
    expect(await (await get(id)).json()).toEqual({ episode: null, available: false });
    expect((await post(id)).status).toBe(422);
    expect((await post(randomUUID())).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });

  it("needs sign-in, and says episodes are off when they are", async () => {
    const id = await seedItem();
    expect((await ctx.app.request(`${BASE_URL}/items/${id}/episode`)).status).toBe(401);
    expect(await (await get(id, offCookie, off)).json()).toEqual({ episode: null, available: false });
  });
});

describe("/podcast/audio (local)", () => {
  it("serves files with byte ranges and nothing outside its directory", async () => {
    await mkdir(join(dir, "podcast", "items"), { recursive: true });
    await writeFile(join(dir, "podcast", "items", "a.m4a"), Buffer.from("0123456789"));

    const whole = await ctx.app.request(`${BASE_URL}/podcast/audio/podcast/items/a.m4a`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mp4");
    expect(await whole.text()).toBe("0123456789");

    const part = await ctx.app.request(`${BASE_URL}/podcast/audio/podcast/items/a.m4a`, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect((await ctx.app.request(`${BASE_URL}/podcast/audio/podcast/items/a.m4a`, { headers: { range: "bytes=20-" } })).status).toBe(416);

    expect((await ctx.app.request(`${BASE_URL}/podcast/audio/%2E%2E/%2E%2E/etc/passwd.m4a`)).status).toBe(404);
    expect((await ctx.app.request(`${BASE_URL}/podcast/audio/podcast/items/missing.m4a`)).status).toBe(404);
    // Not mounted without a directory (as on AWS).
    expect((await off.app.request(`${BASE_URL}/podcast/audio/podcast/items/a.m4a`)).status).toBe(404);
  });
});
