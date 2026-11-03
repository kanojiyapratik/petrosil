CREATE TABLE IF NOT EXISTS "trade_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"product_label" varchar(120) NOT NULL,
	"period_month" date NOT NULL,
	"source_filename" varchar(191) NOT NULL,
	"sheet_name" varchar(120),
	"row_count" integer NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"missing_columns" jsonb,
	"uploaded_by" integer,
	"superseded_at" timestamp with time zone,
	"analysis_status" varchar(24),
	"analysis_text" text,
	"analysis_model" varchar(120),
	"analysis_error" text,
	"analysis_at" timestamp with time zone,
	"analysis_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_id" integer NOT NULL,
	"shipment_date" date NOT NULL,
	"hs_code" varchar(32),
	"product_description" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"unit" varchar(24),
	"standard_quantity" numeric(20, 6),
	"unit_price_usd" numeric(20, 6),
	"cif_value_usd" numeric(20, 6),
	"importer_name" varchar(255),
	"importer_city" varchar(120),
	"supplier_name" varchar(255),
	"supplier_country" varchar(120),
	"foreign_country" varchar(120),
	"foreign_port" varchar(120),
	"indian_port" varchar(120),
	"shipment_mode" varchar(60),
	"incoterms" varchar(24),
	"raw" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_imports" ADD CONSTRAINT "trade_imports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_imports" ADD CONSTRAINT "trade_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_imports" ADD CONSTRAINT "trade_imports_analysis_by_users_id_fk" FOREIGN KEY ("analysis_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_shipments" ADD CONSTRAINT "trade_shipments_import_id_trade_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."trade_imports"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_imports_site_idx" ON "trade_imports" USING btree ("site_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_imports_current_unique" ON "trade_imports" USING btree ("site_id",lower("product_label"),"period_month") WHERE superseded_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_shipments_import_idx" ON "trade_shipments" USING btree ("import_id");