import { type Db, getOrCreateInboundAddress, type InboundAddressRow, rotateInboundAddress, schema } from "@fs/db";
import { newInboundLocalPart } from "@fs/ingest";
import type { ForwardingConfirmation, NewsletterAddress, NewsletterSender, NewslettersView } from "@fs/schema";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { apiError } from "../lib/errors.ts";
import { createRateLimiter } from "../lib/rate-limit.ts";
import { type AuthedEnv, requireUser } from "../lib/session.ts";

const { inboundMessage, publisher, source, userSource } = schema;

export interface NewsletterRouteDeps {
  db: Db;
  /** The inbound email domain; null when newsletter forwarding isn't set up (no domain on AWS). */
  inboundDomain: string | null;
}

/** Confirmations older than this aren't shown (Gmail's codes don't last much longer anyway). */
const CONFIRMATION_DAYS = 7;

/**
 * /me/newsletters (docs/imports/README.md, "Newsletters by email"): the
 * user's personal inbound address (made on first use), forwarding
 * confirmations that arrived at it, and the senders received so far. Each
 * sender is a `newsletter` source, so it's paused and removed like any other
 * (PATCH/DELETE /me/sources/:id).
 */
export function newsletterRoutes({ db, inboundDomain }: NewsletterRouteDeps) {
  // Rotating makes the old address bounce; a few times an hour is plenty.
  const rotateLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });

  return new Hono<AuthedEnv>()
    .use(requireUser)
    .use(async (c, next) => {
      if (!inboundDomain) return apiError(c, 503, "NOT_CONFIGURED", "Newsletter forwarding isn't set up on this server yet");
      await next();
    })

    .get("/", async (c) => {
      const userId = c.get("user").id;
      const address = await getOrCreateInboundAddress(db, userId, () => newInboundLocalPart());
      const view: NewslettersView = {
        address: addressView(address, inboundDomain!),
        ...(await loadNewsletterActivity(db, userId)),
      };
      return c.json(view);
    })

    .get("/address", async (c) => {
      const address = await getOrCreateInboundAddress(db, c.get("user").id, () => newInboundLocalPart());
      return c.json({ address: addressView(address, inboundDomain!) });
    })

    // The old address stops working at once; filters pointing at it need the new one.
    .post("/address/rotate", async (c) => {
      const userId = c.get("user").id;
      if (!rotateLimiter(userId)) return apiError(c, 429, "RATE_LIMITED", "Too many new addresses. Try again later.");
      const address = await rotateInboundAddress(db, userId, () => newInboundLocalPart());
      return c.json({ address: addressView(address, inboundDomain!) });
    });
}

function addressView(row: InboundAddressRow, domain: string): NewsletterAddress {
  return { email: `${row.localPart}@${domain}`, createdAt: row.createdAt.toISOString() };
}

async function loadNewsletterActivity(db: Db, userId: string): Promise<Omit<NewslettersView, "address">> {
  const [confirmations, senders, [skipped]] = await Promise.all([
    db
      .select({ id: inboundMessage.id, confirmation: inboundMessage.confirmation, receivedAt: inboundMessage.receivedAt })
      .from(inboundMessage)
      .where(
        and(
          eq(inboundMessage.userId, userId),
          eq(inboundMessage.status, "confirmation"),
          gt(inboundMessage.receivedAt, sql`now() - make_interval(days => ${CONFIRMATION_DAYS})`),
        ),
      )
      .orderBy(desc(inboundMessage.receivedAt))
      .limit(3),
    db
      .select({
        sourceId: source.id,
        title: source.title,
        sender: source.inputUrl,
        publisher: publisher.name,
        blocked: userSource.blocked,
        lastReceivedAt: source.lastFetchedAt,
        // Distinct pieces: one email linked to an existing item (its RSS copy) still counts once.
        itemCount: sql<number>`(select count(distinct im.item_id)::int from inbound_message im
          where im.user_id = ${userId} and im.source_id = "source"."id" and im.status = 'newsletter')`,
      })
      .from(userSource)
      .innerJoin(source, eq(source.id, userSource.sourceId))
      .innerJoin(publisher, eq(publisher.id, source.publisherId))
      .where(and(eq(userSource.userId, userId), eq(source.type, "newsletter")))
      .orderBy(desc(source.lastFetchedAt)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(inboundMessage)
      .where(
        and(
          eq(inboundMessage.userId, userId),
          eq(inboundMessage.status, "rejected"),
          gt(inboundMessage.receivedAt, sql`now() - interval '30 days'`),
        ),
      ),
  ]);

  return {
    confirmations: confirmations
      .filter((r) => r.confirmation)
      .map(
        (r): ForwardingConfirmation => ({
          id: r.id,
          provider: r.confirmation!.provider,
          code: r.confirmation!.code,
          url: r.confirmation!.url,
          requestedBy: r.confirmation!.requestedBy,
          receivedAt: r.receivedAt.toISOString(),
        }),
      ),
    senders: senders.map(
      (s): NewsletterSender => ({
        sourceId: s.sourceId,
        title: s.title,
        sender: s.sender.replace(/^mailto:/, ""),
        publisher: s.publisher,
        itemCount: s.itemCount,
        lastReceivedAt: s.lastReceivedAt?.toISOString() ?? null,
        following: !s.blocked,
      }),
    ),
    skipped: skipped?.n ?? 0,
  };
}
