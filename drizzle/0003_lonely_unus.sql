CREATE TABLE IF NOT EXISTS "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"code" varchar(64) NOT NULL,
	"percent_off" integer,
	"amount_off" numeric(12, 2),
	"currency" varchar(3),
	"max_redemptions" integer,
	"redeemed" integer DEFAULT 0 NOT NULL,
	"starts_at" date,
	"expires_at" date,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"plan_id" integer,
	"plan_name" varchar(191) NOT NULL,
	"years" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"list_amount" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"coupon_id" integer,
	"coupon_code" varchar(64),
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"provider" varchar(32) DEFAULT 'razorpay' NOT NULL,
	"provider_order_id" varchar(191),
	"provider_payment_id" varchar(191),
	"paid_at" timestamp with time zone,
	"granted_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_payment_id" varchar(191),
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(24) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"years" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(191) NOT NULL,
	"description" text,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trial_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"note" text,
	"days" integer DEFAULT 14 NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "coupons" ADD CONSTRAINT "coupons_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plans" ADD CONSTRAINT "plans_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_unique" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_site_idx" ON "orders" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_provider_order_unique" ON "orders" USING btree ("provider_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_prices_plan_years_unique" ON "plan_prices" USING btree ("plan_id","years");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plans_site_code_unique" ON "plans" USING btree ("site_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trial_requests_site_idx" ON "trial_requests" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trial_requests_user_idx" ON "trial_requests" USING btree ("user_id");