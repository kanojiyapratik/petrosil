ALTER TABLE "price_batches" ADD COLUMN "analysis_status" varchar(24);--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_text" text;--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_summary" jsonb;--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_model" varchar(120);--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_error" text;--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "price_batches" ADD COLUMN "analysis_by" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "price_batches" ADD CONSTRAINT "price_batches_analysis_by_users_id_fk" FOREIGN KEY ("analysis_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
