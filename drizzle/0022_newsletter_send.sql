CREATE TABLE IF NOT EXISTS "newsletter_opt_outs" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"email" varchar(191) NOT NULL,
	"source" varchar(16) DEFAULT 'link' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_sends" ADD COLUMN "newsletter_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "newsletter_opt_outs" ADD CONSTRAINT "newsletter_opt_outs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "newsletter_opt_outs_site_email_unique" ON "newsletter_opt_outs" USING btree ("site_id","email");