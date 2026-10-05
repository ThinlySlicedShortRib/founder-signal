CREATE TYPE "public"."source_import_method" AS ENUM('opml', 'youtube', 'substack', 'bluesky', 'mastodon');--> statement-breakpoint
CREATE TABLE "oauth_flow" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"method" "source_import_method" NOT NULL,
	"label" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"notes" text[] DEFAULT '{}' NOT NULL,
	"found_count" integer NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_source" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_flow" ADD CONSTRAINT "oauth_flow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_import" ADD CONSTRAINT "source_import_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_import_user_idx" ON "source_import" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "user_source" ADD CONSTRAINT "user_source_import_id_source_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."source_import"("id") ON DELETE set null ON UPDATE no action;