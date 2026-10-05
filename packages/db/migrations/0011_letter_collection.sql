-- Every letter has at least three pieces (§6.2): older rows below the minimum become it before the check.
UPDATE "schedule" SET "item_count" = 3 WHERE "item_count" < 3;--> statement-breakpoint
ALTER TABLE "letter" ADD COLUMN "collection" jsonb;--> statement-breakpoint
ALTER TABLE "letter" ADD COLUMN "short_reason" text;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_item_count_min" CHECK ("schedule"."item_count" >= 3);
