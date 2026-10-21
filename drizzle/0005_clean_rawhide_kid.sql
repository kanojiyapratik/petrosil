CREATE TABLE IF NOT EXISTS "ad_placements" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"title" varchar(191) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"placement_id" integer,
	"title" varchar(191) NOT NULL,
	"ad_type" varchar(16) DEFAULT 'image' NOT NULL,
	"image" varchar(512),
	"video" varchar(512),
	"code" text,
	"url" text,
	"starts_at" date,
	"ends_at" date,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"on_dashboard" boolean DEFAULT false NOT NULL,
	"on_newsletter" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "currencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(3) NOT NULL,
	"title" varchar(96) NOT NULL,
	"symbol" varchar(8) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"form" varchar(16) NOT NULL,
	"key" varchar(96) NOT NULL,
	"label" varchar(191) NOT NULL,
	"show_free" boolean DEFAULT false NOT NULL,
	"show_premium" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "impex_sheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"slug" varchar(191) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"file" varchar(512),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"authored_on" date,
	"clicks" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"path" varchar(512) NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(96) NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "newsletter_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"title" varchar(191) NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "newsletters" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"template_id" integer,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"recipients" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"user_id" integer,
	"subject" varchar(255) NOT NULL,
	"offer_type" varchar(16) NOT NULL,
	"keywords" varchar(255),
	"description" text,
	"contact_person" varchar(191),
	"contact_email" varchar(191),
	"contact_phone" varchar(64),
	"company_name" varchar(191),
	"city" varchar(96),
	"state" varchar(96),
	"country" varchar(96),
	"offer_value" varchar(64),
	"image" varchar(512),
	"file" varchar(512),
	"status" varchar(24) DEFAULT 'premium' NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"authored_on" date,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"slug" varchar(191) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"report_type" varchar(64) NOT NULL,
	"file" varchar(512),
	"thumbnail" varchar(512),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"authored_on" date,
	"clicks" integer DEFAULT 0 NOT NULL,
	"meta_title" varchar(255),
	"meta_description" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"permission" varchar(96) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"name" varchar(96) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"key" varchar(96) NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"title" varchar(191) NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_quantities" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"from_location_id" integer,
	"to_location_id" integer,
	"qty" numeric(18, 3),
	"qty_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads" ADD CONSTRAINT "ads_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads" ADD CONSTRAINT "ads_placement_id_ad_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ad_placements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "impex_sheets" ADD CONSTRAINT "impex_sheets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_files" ADD CONSTRAINT "media_files_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_files" ADD CONSTRAINT "media_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "newsletter_templates" ADD CONSTRAINT "newsletter_templates_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_template_id_newsletter_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."newsletter_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offers" ADD CONSTRAINT "offers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offers" ADD CONSTRAINT "offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roles" ADD CONSTRAINT "roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "settings" ADD CONSTRAINT "settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_locations" ADD CONSTRAINT "trade_locations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_quantities" ADD CONSTRAINT "trade_quantities_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_quantities" ADD CONSTRAINT "trade_quantities_from_location_id_trade_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."trade_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_quantities" ADD CONSTRAINT "trade_quantities_to_location_id_trade_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."trade_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_placements_site_title_unique" ON "ad_placements" USING btree ("site_id","title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_placement_idx" ON "ads" USING btree ("site_id","placement_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "currencies_code_unique" ON "currencies" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_fields_site_form_key_unique" ON "form_fields" USING btree ("site_id","form","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "impex_sheets_site_slug_unique" ON "impex_sheets" USING btree ("site_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "media_files_path_unique" ON "media_files" USING btree ("path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_files_site_idx" ON "media_files" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "newsletter_templates_site_title_unique" ON "newsletter_templates" USING btree ("site_id","title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "newsletters_site_idx" ON "newsletters" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offers_site_idx" ON "offers" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_site_slug_unique" ON "reports" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_site_status_idx" ON "reports" USING btree ("site_id","status","authored_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_unique" ON "role_permissions" USING btree ("role_id","permission");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_unique" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settings_site_key_unique" ON "settings" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_locations_site_title_unique" ON "trade_locations" USING btree ("site_id","title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_quantities_site_idx" ON "trade_quantities" USING btree ("site_id","kind","qty_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_quantities_cell_unique" ON "trade_quantities" USING btree ("site_id","kind","from_location_id","to_location_id","qty_date");