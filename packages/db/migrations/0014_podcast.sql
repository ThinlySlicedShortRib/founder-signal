CREATE TYPE "public"."episode_status" AS ENUM('queued', 'scripting', 'voicing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "episode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"item_version_id" uuid NOT NULL,
	"format" text NOT NULL,
	"prompt_version" text NOT NULL,
	"voice_key" text NOT NULL,
	"status" "episode_status" DEFAULT 'queued' NOT NULL,
	"script" jsonb,
	"chapters" jsonb,
	"script_method" text,
	"script_model" text,
	"script_problems" text[],
	"tts_engine" text,
	"tts_model" text,
	"audio_key" text,
	"audio_type" text,
	"audio_bytes" integer,
	"duration_seconds" real,
	"sample_rate" integer,
	"words" integer,
	"cost_usd" real,
	"cost" jsonb,
	"generation_ms" integer,
	"requested_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episode_version_format_prompt_voice" UNIQUE("item_version_id","format","prompt_version","voice_key")
);
--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_item_version_id_content_version_id_fk" FOREIGN KEY ("item_version_id") REFERENCES "public"."content_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_item_idx" ON "episode" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "episode_status_idx" ON "episode" USING btree ("status");