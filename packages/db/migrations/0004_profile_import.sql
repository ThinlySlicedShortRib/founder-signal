CREATE TABLE "profile_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"assistant" text NOT NULL,
	"raw_text" text NOT NULL,
	"result" jsonb NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_import" ADD CONSTRAINT "profile_import_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_import_user_created_idx" ON "profile_import" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_import_id_profile_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."profile_import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Kept facts now say which parts of the form they fill; earlier ones only had topics.
UPDATE "profile" SET "imported_facts" = (
	SELECT coalesce(jsonb_agg(jsonb_build_object(
		'kind', f->'kind',
		'text', f->'text',
		'fills', jsonb_build_object('role', null, 'lately', null, 'topics', coalesce(f->'topics', '[]'::jsonb), 'platforms', '[]'::jsonb, 'sources', '[]'::jsonb)
	)), '[]'::jsonb)
	FROM jsonb_array_elements("imported_facts") f
) WHERE jsonb_array_length("imported_facts") > 0 AND NOT ("imported_facts"->0 ? 'fills');
