CREATE TABLE IF NOT EXISTS "enquiries" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"from_user_id" integer,
	"from_name" varchar(191),
	"from_email" varchar(191),
	"from_phone" varchar(64),
	"from_company" varchar(191),
	"to_user_id" integer,
	"offer_id" integer,
	"plan_id" integer,
	"about" varchar(255),
	"subject" varchar(255),
	"message" text NOT NULL,
	"detail" jsonb,
	"handled_by" integer,
	"handled_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enquiries_site_status_idx" ON "enquiries" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enquiries_from_idx" ON "enquiries" USING btree ("from_user_id","created_at");