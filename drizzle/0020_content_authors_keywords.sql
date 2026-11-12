ALTER TABLE "articles" ADD COLUMN "keywords" varchar(255);--> statement-breakpoint
ALTER TABLE "impex_sheets" ADD COLUMN "author_id" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "author_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "impex_sheets" ADD CONSTRAINT "impex_sheets_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
