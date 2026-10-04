CREATE TYPE "public"."interaction_type" AS ENUM('open', 'complete', 'uncomplete', 'save', 'unsave', 'summary_expand', 'skip');--> statement-breakpoint
CREATE TYPE "public"."letter_status" AS ENUM('scheduled', 'collecting', 'ranking', 'generating', 'verifying', 'ready', 'sending', 'sent', 'short_sent', 'skipped_no_candidates', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "author" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"role" text,
	"headline" text,
	"short" text,
	"bio" text,
	"stats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"known_for" text[] DEFAULT '{}' NOT NULL,
	"site_url" text,
	"follow_url" text,
	"provenance" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrichment_status" text DEFAULT 'pending' NOT NULL,
	"enrichment_method" text,
	"enrichment_started_at" timestamp with time zone,
	"enrichment_attempts" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "author_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "interaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"letter_id" uuid,
	"type" "interaction_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"local_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"status" "letter_status" DEFAULT 'scheduled' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"number" integer,
	"delivered_at" timestamp with time zone,
	"short" boolean DEFAULT false NOT NULL,
	"headline" text,
	"intro" text,
	"why_this_mix" text,
	"generation_meta" jsonb,
	"step_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"work" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"watchdog_at" timestamp with time zone,
	"failure_reason" text,
	"leanings" text[] DEFAULT '{}' NOT NULL,
	"chosen_leanings" text[] DEFAULT '{}' NOT NULL,
	"postscript_recap" text,
	"postscript_recap_signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "letter_user_occurrence" UNIQUE("user_id","occurrence_id"),
	CONSTRAINT "letter_user_number" UNIQUE("user_id","number")
);
--> statement-breakpoint
CREATE TABLE "letter_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"letter_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"feedback_code" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"pick_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "letter_item_letter_item" UNIQUE("letter_id","item_id"),
	CONSTRAINT "letter_item_letter_code" UNIQUE("letter_id","feedback_code"),
	CONSTRAINT "letter_item_letter_position" UNIQUE("letter_id","position")
);
--> statement-breakpoint
CREATE TABLE "stock_photo" (
	"topic" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"photos" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_version_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"claim" text NOT NULL,
	"evidence" text NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_version_section" UNIQUE("item_version_id","section_id")
);
--> statement-breakpoint
CREATE TABLE "user_author" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"author_id" uuid NOT NULL,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_author_user_author" UNIQUE("user_id","author_id")
);
--> statement-breakpoint
ALTER TABLE "content_item" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "content_item" ADD COLUMN "author_key" text;--> statement-breakpoint
ALTER TABLE "content_item" ADD COLUMN "lead_image_url" text;--> statement-breakpoint
ALTER TABLE "content_item" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "short_letter_policy" text DEFAULT 'shorten' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "item_count" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_letter_id_letter_id_fk" FOREIGN KEY ("letter_id") REFERENCES "public"."letter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter" ADD CONSTRAINT "letter_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_item" ADD CONSTRAINT "letter_item_letter_id_letter_id_fk" FOREIGN KEY ("letter_id") REFERENCES "public"."letter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letter_item" ADD CONSTRAINT "letter_item_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary" ADD CONSTRAINT "summary_item_version_id_content_version_id_fk" FOREIGN KEY ("item_version_id") REFERENCES "public"."content_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_author" ADD CONSTRAINT "user_author_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_author" ADD CONSTRAINT "user_author_author_id_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."author"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_author" ADD CONSTRAINT "user_author_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_user_day_idx" ON "interaction" USING btree ("user_id","local_day");--> statement-breakpoint
CREATE INDEX "interaction_user_item_idx" ON "interaction" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "letter_status_watchdog_idx" ON "letter" USING btree ("status","watchdog_at");--> statement-breakpoint
CREATE INDEX "letter_user_delivered_idx" ON "letter" USING btree ("user_id","delivered_at");--> statement-breakpoint
CREATE INDEX "letter_item_item_idx" ON "letter_item" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "content_item_author_key_idx" ON "content_item" USING btree ("author_key");