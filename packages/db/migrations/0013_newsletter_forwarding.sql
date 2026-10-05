CREATE TYPE "public"."inbound_message_status" AS ENUM('pending', 'newsletter', 'confirmation', 'rejected', 'failed');--> statement-breakpoint
ALTER TYPE "public"."source_import_method" ADD VALUE 'newsletter';--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'newsletter';--> statement-breakpoint
CREATE TABLE "inbound_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"local_part" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "inbound_address_local_part_unique" UNIQUE("local_part")
);
--> statement-breakpoint
CREATE TABLE "inbound_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_key" text NOT NULL,
	"envelope_to" text[],
	"address_id" uuid,
	"user_id" text,
	"status" "inbound_message_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"message_id_hash" text,
	"from_address" text,
	"subject" text,
	"verdicts" jsonb,
	"spam" boolean DEFAULT false NOT NULL,
	"confirmation" jsonb,
	"source_id" uuid,
	"item_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_message_raw_key_unique" UNIQUE("raw_key")
);
--> statement-breakpoint
ALTER TABLE "inbound_address" ADD CONSTRAINT "inbound_address_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_address" ADD CONSTRAINT "inbound_address_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_address_id_inbound_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."inbound_address"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_address_one_active" ON "inbound_address" USING btree ("user_id") WHERE "inbound_address"."active";--> statement-breakpoint
CREATE INDEX "inbound_message_address_idx" ON "inbound_message" USING btree ("address_id","received_at");--> statement-breakpoint
CREATE INDEX "inbound_message_user_idx" ON "inbound_message" USING btree ("user_id","status","received_at");--> statement-breakpoint
CREATE INDEX "inbound_message_item_idx" ON "inbound_message" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "inbound_message_pending_idx" ON "inbound_message" USING btree ("received_at") WHERE "inbound_message"."status" = 'pending';