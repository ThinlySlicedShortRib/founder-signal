CREATE TYPE "public"."content_status" AS ENUM('pending', 'extracted', 'metadata_only', 'enriched', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('article', 'video');--> statement-breakpoint
CREATE TYPE "public"."enrichment_batch_status" AS ENUM('submitted', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."publisher_origin" AS ENUM('user_added', 'discovered');--> statement-breakpoint
CREATE TYPE "public"."publisher_status" AS ENUM('candidate', 'trial', 'trusted', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."rights_display" AS ENUM('full_text', 'excerpt_only', 'link_only');--> statement-breakpoint
CREATE TYPE "public"."rights_scope" AS ENUM('domain', 'source');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('feed', 'url', 'youtube_channel');--> statement-breakpoint
CREATE TYPE "public"."user_source_mode" AS ENUM('more_like_this', 'follow_closely', 'occasional');--> statement-breakpoint
CREATE TABLE "content_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_url" text NOT NULL,
	"type" "content_type" NOT NULL,
	"source_id" uuid,
	"publisher_id" uuid NOT NULL,
	"title" text,
	"creator" text,
	"published_at" timestamp with time zone,
	"external_id" text,
	"status" "content_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"word_count" integer,
	"read_time_minutes" integer,
	"simhash" bigint,
	"duplicate_of_id" uuid,
	"language" text,
	"tags" text[],
	"depth" text,
	"quality_label" text,
	"embedding" vector(1024),
	"enrichment_batch_id" uuid,
	"enrichment_attempts" integer DEFAULT 0 NOT NULL,
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_item_canonical_url_unique" UNIQUE("canonical_url"),
	CONSTRAINT "content_item_video_has_id" CHECK ("content_item"."type" <> 'video' OR "content_item"."external_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "content_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocks_key" text,
	"section_map" jsonb NOT NULL,
	"rights_snapshot" jsonb NOT NULL,
	"excerpt" text,
	CONSTRAINT "content_version_item_hash" UNIQUE("item_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "enrichment_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_batch_id" text NOT NULL,
	"status" "enrichment_batch_status" DEFAULT 'submitted' NOT NULL,
	"item_count" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "enrichment_batch_provider_batch_id_unique" UNIQUE("provider_batch_id")
);
--> statement-breakpoint
CREATE TABLE "publisher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"feed_url" text,
	"status" "publisher_status" DEFAULT 'candidate' NOT NULL,
	"origin" "publisher_origin" NOT NULL,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"extractions_ok" integer DEFAULT 0 NOT NULL,
	"extractions_failed" integer DEFAULT 0 NOT NULL,
	"verifications_passed" integer DEFAULT 0 NOT NULL,
	"verifications_failed" integer DEFAULT 0 NOT NULL,
	"interested_count" integer DEFAULT 0 NOT NULL,
	"not_interested_count" integer DEFAULT 0 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publisher_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rights_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "rights_scope" NOT NULL,
	"scope_key" text NOT NULL,
	"display" "rights_display" NOT NULL,
	"retain_text" boolean NOT NULL,
	"offline_allowed" boolean NOT NULL,
	"license_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_rule_scope_key" UNIQUE("scope","scope_key")
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"type" "source_type" NOT NULL,
	"publisher_id" uuid NOT NULL,
	"title" text NOT NULL,
	"creator" text,
	"input_url" text NOT NULL,
	"fetch_url" text NOT NULL,
	"next_fetch_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"last_fetch_status" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"etag" text,
	"last_modified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_canonical_key_unique" UNIQUE("canonical_key")
);
--> statement-breakpoint
CREATE TABLE "transcript" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_version_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real,
	"language" text,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_item_version_id_unique" UNIQUE("item_version_id")
);
--> statement-breakpoint
CREATE TABLE "user_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"mode" "user_source_mode" DEFAULT 'more_like_this' NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_source_user_source" UNIQUE("user_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_publisher_id_publisher_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publisher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_enrichment_batch_id_enrichment_batch_id_fk" FOREIGN KEY ("enrichment_batch_id") REFERENCES "public"."enrichment_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_version" ADD CONSTRAINT "content_version_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_publisher_id_publisher_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publisher"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_item_version_id_content_version_id_fk" FOREIGN KEY ("item_version_id") REFERENCES "public"."content_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_source" ADD CONSTRAINT "user_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_source" ADD CONSTRAINT "user_source_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_item_status_idx" ON "content_item" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_item_publisher_idx" ON "content_item" USING btree ("publisher_id");--> statement-breakpoint
CREATE INDEX "content_item_source_idx" ON "content_item" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "source_next_fetch_at_idx" ON "source" USING btree ("next_fetch_at");