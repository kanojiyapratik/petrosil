CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"user_id" integer,
	"token_id" integer,
	"action" varchar(64) NOT NULL,
	"entity" varchar(64),
	"entity_id" integer,
	"detail" jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"title" varchar(191) NOT NULL,
	"currency" varchar(3),
	"unit" varchar(32),
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"site_id" integer NOT NULL,
	"role" varchar(24) DEFAULT 'subscriber' NOT NULL,
	"tier" varchar(24) DEFAULT 'free' NOT NULL,
	"expires_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_batch_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"raw_location" varchar(191) NOT NULL,
	"location_id" integer,
	"price_id" integer,
	"price_date" date NOT NULL,
	"old_price" numeric(14, 4),
	"new_price" numeric(14, 4) NOT NULL,
	"currency" varchar(3),
	"status" varchar(24) NOT NULL,
	"is_included" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"source" varchar(24) NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"created_by" integer,
	"committed_by" integer,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_crawl_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"url_id" integer,
	"location_id" integer,
	"location" varchar(191) NOT NULL,
	"price" numeric(14, 4),
	"price_date" date,
	"previous_price" numeric(14, 4),
	"site_price" numeric(14, 4),
	"change_type" varchar(24),
	"change_pct" numeric(10, 4),
	"differs_from_site" boolean DEFAULT false NOT NULL,
	"staged_batch_id" integer,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_crawl_urls" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"url" text NOT NULL,
	"label" varchar(191),
	"enabled" boolean DEFAULT true NOT NULL,
	"etag" varchar(191),
	"last_modified" varchar(191),
	"content_hash" varchar(64),
	"last_status" varchar(24),
	"last_error" text,
	"last_notes" text,
	"last_row_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"price_batch_id" integer,
	"source" varchar(32) DEFAULT 'editorial' NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"price" numeric(14, 4) NOT NULL,
	"currency" varchar(3),
	"price_date" date NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" varchar(191) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_crawl_settings" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"instructions" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(191) NOT NULL,
	"legacy_domain" varchar(191),
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"price_cadence" varchar(64),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(191) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" varchar(191),
	"name" varchar(191) NOT NULL,
	"company" varchar(191),
	"designation" varchar(191),
	"phone" varchar(64),
	"country" varchar(96),
	"city" varchar(96),
	"website" varchar(191),
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_token_id_site_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."site_api_tokens"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locations" ADD CONSTRAINT "locations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batch_items" ADD CONSTRAINT "price_batch_items_batch_id_price_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."price_batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batch_items" ADD CONSTRAINT "price_batch_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batch_items" ADD CONSTRAINT "price_batch_items_price_id_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."prices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batches" ADD CONSTRAINT "price_batches_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batches" ADD CONSTRAINT "price_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batches" ADD CONSTRAINT "price_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_crawl_activities" ADD CONSTRAINT "price_crawl_activities_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_crawl_activities" ADD CONSTRAINT "price_crawl_activities_url_id_price_crawl_urls_id_fk" FOREIGN KEY ("url_id") REFERENCES "public"."price_crawl_urls"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_crawl_activities" ADD CONSTRAINT "price_crawl_activities_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_crawl_activities" ADD CONSTRAINT "price_crawl_activities_staged_batch_id_price_batches_id_fk" FOREIGN KEY ("staged_batch_id") REFERENCES "public"."price_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_crawl_urls" ADD CONSTRAINT "price_crawl_urls_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_summaries" ADD CONSTRAINT "price_summaries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_summaries" ADD CONSTRAINT "price_summaries_price_batch_id_price_batches_id_fk" FOREIGN KEY ("price_batch_id") REFERENCES "public"."price_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prices" ADD CONSTRAINT "prices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prices" ADD CONSTRAINT "prices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_api_tokens" ADD CONSTRAINT "site_api_tokens_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_crawl_settings" ADD CONSTRAINT "site_crawl_settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_site_idx" ON "audit_log" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locations_site_title_unique" ON "locations" USING btree ("site_id","title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_site_idx" ON "locations" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_user_site_unique" ON "memberships" USING btree ("user_id","site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_site_idx" ON "memberships" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_batch_items_batch_idx" ON "price_batch_items" USING btree ("batch_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_batches_site_idx" ON "price_batches" USING btree ("site_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_crawl_activities_site_idx" ON "price_crawl_activities" USING btree ("site_id","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_crawl_urls_site_idx" ON "price_crawl_urls" USING btree ("site_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_summaries_site_idx" ON "price_summaries" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prices_location_date_live_unique" ON "prices" USING btree ("location_id","price_date") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prices_site_date_idx" ON "prices" USING btree ("site_id","price_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_api_tokens_hash_unique" ON "site_api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_api_tokens_site_idx" ON "site_api_tokens" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sites_slug_unique" ON "sites" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");