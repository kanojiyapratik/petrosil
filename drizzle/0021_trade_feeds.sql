CREATE TABLE IF NOT EXISTS "trade_feeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"source" varchar(24) NOT NULL,
	"hs_codes" jsonb NOT NULL,
	"product" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status" varchar(24),
	"last_error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_location_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"alias" varchar(191) NOT NULL,
	"location_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"feed_id" integer NOT NULL,
	"qty_date" date NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"rows" jsonb NOT NULL,
	"source_url" text,
	"source_unit" varchar(16),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" integer,
	"insight_status" varchar(24),
	"insight_text" text,
	"insight_model" varchar(120),
	"insight_error" text,
	"insight_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_feeds" ADD CONSTRAINT "trade_feeds_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_feeds" ADD CONSTRAINT "trade_feeds_location_id_trade_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."trade_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_feeds" ADD CONSTRAINT "trade_feeds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_location_aliases" ADD CONSTRAINT "trade_location_aliases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_location_aliases" ADD CONSTRAINT "trade_location_aliases_location_id_trade_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."trade_locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_updates" ADD CONSTRAINT "trade_updates_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_updates" ADD CONSTRAINT "trade_updates_feed_id_trade_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."trade_feeds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_updates" ADD CONSTRAINT "trade_updates_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_feeds_sheet_unique" ON "trade_feeds" USING btree ("site_id","location_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_location_aliases_unique" ON "trade_location_aliases" USING btree ("site_id",lower("alias"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_updates_site_idx" ON "trade_updates" USING btree ("site_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_updates_pending_unique" ON "trade_updates" USING btree ("feed_id","qty_date") WHERE status = 'pending';