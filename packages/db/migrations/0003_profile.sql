CREATE TYPE "public"."review_origin" AS ENUM('in_app', 'onboarding', 'imported');--> statement-breakpoint
CREATE TYPE "public"."review_vote" AS ENUM('interested', 'not_interested');--> statement-breakpoint
CREATE TYPE "public"."topic_origin" AS ENUM('explicit', 'learned');--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" text,
	"lately" text,
	"platforms" text[] DEFAULT '{}' NOT NULL,
	"imported_from" text,
	"imported_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"onboarded_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"vote" "review_vote" NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"free_text" text,
	"origin" "review_origin" NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_user_item" UNIQUE("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preset" text,
	"weekdays" integer[] NOT NULL,
	"local_time" text NOT NULL,
	"time_zone" text NOT NULL,
	"channels" text[] DEFAULT '{"push","email"}' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"skip_next" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_weight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"origin" "topic_origin" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_weight_user_topic" UNIQUE("user_id","topic")
);
--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_item_id_content_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_weight" ADD CONSTRAINT "topic_weight_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_next_run_at_idx" ON "schedule" USING btree ("next_run_at");