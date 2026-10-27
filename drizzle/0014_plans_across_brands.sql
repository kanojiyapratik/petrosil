-- A plan is no longer one brand's in one currency: it applies to the brands in
-- plan_sites, and each price row says its currency. Every carried plan keeps
-- exactly what it had — its one brand, and its prices in its one currency —
-- so nothing on sale changes until somebody edits a plan.
CREATE TABLE IF NOT EXISTS "plan_sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"site_id" integer NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_sites" ADD CONSTRAINT "plan_sites_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_sites" ADD CONSTRAINT "plan_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_sites_plan_site_unique" ON "plan_sites" USING btree ("plan_id","site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_sites_site_idx" ON "plan_sites" USING btree ("site_id");--> statement-breakpoint
INSERT INTO "plan_sites" ("plan_id", "site_id") SELECT "id", "site_id" FROM "plans";--> statement-breakpoint
ALTER TABLE "plan_prices" ADD COLUMN "currency" varchar(3);--> statement-breakpoint
UPDATE "plan_prices" pp SET "currency" = p."currency" FROM "plans" p WHERE p."id" = pp."plan_id";--> statement-breakpoint
ALTER TABLE "plan_prices" ALTER COLUMN "currency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD COLUMN "sale_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "on_sale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Codes were unique per brand, and six brands share "admin-name-free-trial".
-- A code the estate now shares gets its brand appended; a unique one stays.
UPDATE "plans" p
   SET "code" = left(p."code", 63 - length(s."slug")) || '-' || s."slug"
  FROM "sites" s
 WHERE s."id" = p."site_id"
   AND p."code" IN (SELECT "code" FROM "plans" GROUP BY "code" HAVING count(*) > 1);--> statement-breakpoint
DROP INDEX IF EXISTS "plan_prices_plan_years_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "plans_site_code_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_prices_plan_currency_years_unique" ON "plan_prices" USING btree ("plan_id","currency","years");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plans_code_unique" ON "plans" USING btree ("code");--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_site_id_sites_id_fk";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "site_id";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "currency";
