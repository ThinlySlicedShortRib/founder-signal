import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { sourceImport } from "./imports.ts";
import { contentItem, source } from "./ingestion.ts";

/**
 * Newsletter forwarding (docs/imports/README.md, "Newsletters by email"): each
 * user has a personal inbound address; newsletters forwarded to it become
 * items of a `newsletter` source per sender.
 */

/**
 * A user's inbound address, `<local_part>@<inbound domain>`. The local part
 * (`n-` + 12 random base32 characters) is the only thing that identifies the
 * user, so it's unguessable. Rotating deactivates it and makes a new one; mail
 * to an inactive address is refused. At most one active address per user.
 */
export const inboundAddress = pgTable(
  "inbound_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull().unique(),
    active: boolean("active").default(true).notNull(),
    /** Where the newsletter sources it creates "came from" (`user_source.import_id`). */
    importId: uuid("import_id").references(() => sourceImport.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** Set when it was replaced by a new address. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("inbound_address_one_active").on(t.userId).where(sql`${t.active}`)],
);

/**
 * What happened to a received message:
 * - `pending`: stored, not processed yet (the raw MIME is in the mail store);
 * - `newsletter`: an item of a newsletter source (`item_id`; possibly an
 *   existing item with the same URL or text);
 * - `confirmation`: a Gmail/Outlook forwarding confirmation (`confirmation`);
 * - `rejected`: refused, with `reason` (unknown or inactive address, too large,
 *   virus, rate limited, no content, a sender the user stopped following);
 * - `failed`: couldn't be parsed or processed (`reason`).
 */
export const inboundMessageStatus = pgEnum("inbound_message_status", ["pending", "newsletter", "confirmation", "rejected", "failed"]);

/** SPF/DKIM/DMARC and SES's spam/virus scans (`PASS`, `FAIL`, `GRAY`, `PROCESSING_FAILED`), when known. */
export interface InboundVerdicts {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  spam?: string;
  virus?: string;
}

/** A forwarding confirmation, shown in the app until it's used. */
export interface InboundConfirmation {
  provider: "gmail" | "outlook";
  code: string | null;
  /** Only an https link on the provider's own host. */
  url: string | null;
  /** The mailbox asking to forward to us. */
  requestedBy: string | null;
}

/**
 * One received email. Only what's needed is kept: who sent it, the subject,
 * the verdicts and what it became. The body lives on as the item's blocks;
 * the raw message is deleted once processed (and expires from the mail
 * bucket after 7 days anyway).
 */
export const inboundMessage = pgTable(
  "inbound_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Where the raw MIME is (an S3 key from SES, or a local file). Unique: a redelivery is processed once. */
    rawKey: text("raw_key").notNull().unique(),
    /** The envelope recipients (SMTP RCPT TO), when known; otherwise they're read from the headers. */
    envelopeTo: text("envelope_to").array(),
    addressId: uuid("address_id").references(() => inboundAddress.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    status: inboundMessageStatus("status").default("pending").notNull(),
    reason: text("reason"),
    /** SHA-256 of the Message-ID header (dedupes a message forwarded twice). */
    messageIdHash: text("message_id_hash"),
    fromAddress: text("from_address"),
    subject: text("subject"),
    verdicts: jsonb("verdicts").$type<InboundVerdicts>(),
    /** SES's spam scan said FAIL. Kept, but marked. */
    spam: boolean("spam").default(false).notNull(),
    confirmation: jsonb("confirmation").$type<InboundConfirmation>(),
    sourceId: uuid("source_id").references(() => source.id),
    itemId: uuid("item_id").references(() => contentItem.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    /** A worker claimed it (so two deliveries don't process it at once). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("inbound_message_address_idx").on(t.addressId, t.receivedAt),
    index("inbound_message_user_idx").on(t.userId, t.status, t.receivedAt),
    index("inbound_message_item_idx").on(t.itemId),
    index("inbound_message_pending_idx").on(t.receivedAt).where(sql`${t.status} = 'pending'`),
  ],
);
