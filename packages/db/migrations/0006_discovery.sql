CREATE TYPE "public"."discovery_query_status" AS ENUM('pending', 'searched', 'cached', 'skipped_stale', 'skipped_recent', 'skipped_cap', 'duplicate', 'failed');--> statement-breakpoint
CREATE TYPE "public"."discovery_run_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "discovery_query" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"query_text" text NOT NULL,
	"normalized_query" text NOT NULL,
	"origin" text NOT NULL,
	"origin_detail" text,
	"inputs_hash" text NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"status" "discovery_query_status" DEFAULT 'pending' NOT NULL,
	"search_id" uuid,
	"result_count" integer,
	"accepted_count" integer,
	"ran_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"status" "discovery_run_status" DEFAULT 'pending' NOT NULL,
	"letter_due_at" timestamp with time zone NOT NULL,
	"inputs_hash" text,
	"query_method" text,
	"query_model" text,
	"query_prompt_version" text,
	"queries_generated" integer DEFAULT 0 NOT NULL,
	"searches_run" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"items_linked" integer DEFAULT 0 NOT NULL,
	"items_queued" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_run_user_occurrence" UNIQUE("user_id","occurrence_id")
);
--> statement-breakpoint
CREATE TABLE "discovery_search" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_query" text NOT NULL,
	"query_text" text NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"method" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_search_normalized_query_unique" UNIQUE("normalized_query")
);
--> statement-breakpoint
CREATE TABLE "user_discovery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"query_id" uuid,
	"reason" text NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_discovery_user_item" UNIQUE("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "user_publisher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"publisher_id" uuid NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_publisher_user_publisher" UNIQUE("user_id","publisher_id")
);
--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "substantive_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "low_quality_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publisher" ADD COLUMN "feed_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_query" ADD CONSTRAINT "discovery_query_run_id_discovery_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_query" ADD CONSTRAINT "discovery_query_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_query" ADD CONSTRAINT "discovery_query_search_id_discovery_search_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."discovery_search"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_discovery" ADD CONSTRAINT "user_discovery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_discovery" ADD CONSTRAINT "user_discovery_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_discovery" ADD CONSTRAINT "user_discovery_query_id_discovery_query_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."discovery_query"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_publisher" ADD CONSTRAINT "user_publisher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_publisher" ADD CONSTRAINT "user_publisher_publisher_id_publisher_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publisher"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_query_user_query_idx" ON "discovery_query" USING btree ("user_id","normalized_query","ran_at");--> statement-breakpoint
CREATE INDEX "discovery_query_run_idx" ON "discovery_query" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_run_status_idx" ON "discovery_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discovery_search_expires_idx" ON "discovery_search" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_discovery_item_idx" ON "user_discovery" USING btree ("item_id");