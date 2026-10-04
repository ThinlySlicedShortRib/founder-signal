ALTER TABLE "letter" ADD COLUMN IF NOT EXISTS "postscript_default" text;--> statement-breakpoint
ALTER TABLE "letter" ADD COLUMN IF NOT EXISTS "postscript_recap_meta" jsonb;