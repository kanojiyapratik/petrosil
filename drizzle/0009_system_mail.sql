CREATE TABLE IF NOT EXISTS "mail_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"key" varchar(48) NOT NULL,
	"variant" varchar(16) DEFAULT 'default' NOT NULL,
	"title" varchar(191) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"membership_id" integer NOT NULL,
	"kind" varchar(48) NOT NULL,
	"expires_at" date NOT NULL,
	"days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "lapsed_from" varchar(24);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_templates" ADD CONSTRAINT "mail_templates_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "membership_reminders" ADD CONSTRAINT "membership_reminders_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_templates_site_key_variant_unique" ON "mail_templates" USING btree ("site_id","key","variant");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_reminders_once" ON "membership_reminders" USING btree ("membership_id","kind","expires_at","days");