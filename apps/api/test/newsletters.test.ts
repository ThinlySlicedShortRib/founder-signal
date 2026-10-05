import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@fs/db";
import { newslettersViewSchema } from "@fs/schema";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, signIn } from "./helpers.ts";

const { inboundAddress, inboundMessage, publisher, source, sourceImport, userSource } = schema;

const local = createTestApp({ devSignIn: true });
const remote = createTestApp();
const off = createTestApp({ inboundDomain: null });
afterAll(() => Promise.all([local.pool.end(), remote.pool.end(), off.pool.end()]));

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "ingest", "test", "fixtures", "newsletters");

/** Response bodies, loosely typed for assertions. */
type Json = any;
const json = async (res: Response | Promise<Response>): Promise<Json> => (await res).json();

async function get(ctx: typeof local, cookie: string, path: string) {
  return ctx.app.request(`${BASE_URL}${path}`, { headers: { cookie } });
}
async function post(ctx: typeof local, cookie: string, path: string, init: RequestInit = {}) {
  return ctx.app.request(`${BASE_URL}${path}`, { method: "POST", ...init, headers: { cookie, ...(init.headers ?? {}) } });
}

describe("/me/newsletters", () => {
  it("needs a session", async () => {
    expect((await local.app.request(`${BASE_URL}/me/newsletters`)).status).toBe(401);
  });

  it("makes a stable address on first use, with the import its senders will point back to", async () => {
    const cookie = await signIn(local, "nl-first@example.com");
    const res = await get(local, cookie, "/me/newsletters");
    expect(res.status).toBe(200);
    const view = newslettersViewSchema.parse(await json(res));
    expect(view.address.email).toMatch(/^n-[a-z2-7]{12}@in\.test$/);
    expect(view).toMatchObject({ confirmations: [], senders: [], skipped: 0 });

    const again = await json(get(local, cookie, "/me/newsletters/address"));
    expect(again.address.email).toBe(view.address.email);

    const [row] = await local.db.select().from(inboundAddress).where(eq(inboundAddress.localPart, view.address.email.split("@")[0]!));
    const [imp] = await local.db.select().from(sourceImport).where(eq(sourceImport.id, row!.importId!));
    expect(imp).toMatchObject({ method: "newsletter", label: "Newsletters by email" });
  });

  it("rotates: a new address, the old one inactive", async () => {
    const cookie = await signIn(local, "nl-rotate@example.com");
    const before = (await json(get(local, cookie, "/me/newsletters/address"))).address.email as string;
    const res = await post(local, cookie, "/me/newsletters/address/rotate");
    expect(res.status).toBe(200);
    const after = (await json(res)).address.email as string;
    expect(after).not.toBe(before);
    const [old] = await local.db.select().from(inboundAddress).where(eq(inboundAddress.localPart, before.split("@")[0]!));
    expect(old).toMatchObject({ active: false });
    expect(old!.rotatedAt).not.toBeNull();
    expect((await json(get(local, cookie, "/me/newsletters"))).address.email).toBe(after);
  });

  it("lists confirmations and senders with their piece counts", async () => {
    const cookie = await signIn(local, "nl-senders@example.com");
    const view = newslettersViewSchema.parse(await json(get(local, cookie, "/me/newsletters")));
    const [addr] = await local.db.select().from(inboundAddress).where(eq(inboundAddress.localPart, view.address.email.split("@")[0]!));
    const userId = addr!.userId;

    const [pub] = await local.db.insert(publisher).values({ key: `nl-${userId}.example`, name: "Pricing Weekly", origin: "user_added" }).returning();
    const [src] = await local.db
      .insert(source)
      .values({ canonicalKey: `newsletter:${userId}:from:hello@pricingweekly.com`, type: "newsletter", publisherId: pub!.id, title: "Pricing Weekly", inputUrl: "mailto:hello@pricingweekly.com", fetchUrl: "mailto:hello@pricingweekly.com", lastFetchedAt: new Date() })
      .returning();
    await local.db.insert(userSource).values({ userId, sourceId: src!.id });
    await local.db.insert(inboundMessage).values([
      { rawKey: `inbound/${userId}-c`, userId, addressId: addr!.id, status: "confirmation", confirmation: { provider: "gmail", code: "284716395", url: "https://mail-settings.google.com/mail/vf-x", requestedBy: "me@gmail.com" } },
      { rawKey: `inbound/${userId}-r`, userId, addressId: addr!.id, status: "rejected", reason: "no_content" },
      { rawKey: `inbound/${userId}-n`, userId, addressId: addr!.id, status: "newsletter", sourceId: src!.id },
    ]);

    const after = newslettersViewSchema.parse(await json(get(local, cookie, "/me/newsletters")));
    expect(after.confirmations).toEqual([expect.objectContaining({ provider: "gmail", code: "284716395", url: "https://mail-settings.google.com/mail/vf-x", requestedBy: "me@gmail.com" })]);
    expect(after.senders).toEqual([expect.objectContaining({ sourceId: src!.id, title: "Pricing Weekly", sender: "hello@pricingweekly.com", publisher: "Pricing Weekly", itemCount: 0, following: true })]);
    expect(after.skipped).toBe(1);

    // Stopping one is the source's pause switch.
    const patch = await local.app.request(`${BASE_URL}/me/sources/${src!.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ blocked: true }),
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).source).toMatchObject({ type: "newsletter", blocked: true });
    expect((await json(get(local, cookie, "/me/newsletters"))).senders[0].following).toBe(false);
  });

  it("answers NOT_CONFIGURED without an inbound domain", async () => {
    const cookie = await signIn(off, "nl-off@example.com");
    const res = await get(off, cookie, "/me/newsletters");
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("NOT_CONFIGURED");
  });
});

describe("POST /dev/newsletters/inbound", () => {
  it("stores a raw message for the dev runner, addressed to the user's address", async () => {
    const cookie = await signIn(local, "nl-dev@example.com");
    const address = (await json(get(local, cookie, "/me/newsletters/address"))).address.email as string;
    const raw = readFileSync(join(FIXTURES, "substack-post.eml"));
    const res = await post(local, cookie, "/dev/newsletters/inbound", { body: raw, headers: { "content-type": "message/rfc822" } });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ to: address, rawKey: expect.stringMatching(/^inbound\/dev-.+\.eml$/) });
    expect(Buffer.from(local.mailObjects.get(body.rawKey)!).equals(raw)).toBe(true);
    const [row] = await local.db.select().from(inboundMessage).where(eq(inboundMessage.id, body.id));
    expect(row).toMatchObject({ status: "pending", envelopeTo: [address] });

    const list = await json(get(local, cookie, "/dev/newsletters/inbound"));
    expect(list.messages.map((m: { id: string }) => m.id)).toContain(body.id);
  });

  it("takes an .eml upload and an explicit recipient", async () => {
    const cookie = await signIn(local, "nl-dev-upload@example.com");
    const form = new FormData();
    form.set("file", new File([readFileSync(join(FIXTURES, "gmail-forwarding-confirmation.eml"))], "confirm.eml", { type: "message/rfc822" }));
    const res = await post(local, cookie, "/dev/newsletters/inbound?to=n-aaaaaaaaaaaa@in.test", { body: form });
    expect(res.status).toBe(202);
    expect((await json(res)).to).toBe("n-aaaaaaaaaaaa@in.test");
  });

  it("refuses an empty body", async () => {
    const cookie = await signIn(local, "nl-dev-empty@example.com");
    expect((await post(local, cookie, "/dev/newsletters/inbound", { body: "", headers: { "content-type": "message/rfc822" } })).status).toBe(400);
  });

  it("doesn't exist outside local development", async () => {
    const cookie = await signIn(remote, "nl-remote@example.com");
    expect((await post(remote, cookie, "/dev/newsletters/inbound", { body: "x" })).status).toBe(404);
  });
});
