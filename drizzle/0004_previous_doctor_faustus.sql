CREATE TABLE IF NOT EXISTS "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"body" text NOT NULL,
	"link" varchar(512),
	"starts_at" date,
	"ends_at" date,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"slug" varchar(191) NOT NULL,
	"name" varchar(191) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"category_id" integer,
	"slug" varchar(191) NOT NULL,
	"title" varchar(255) NOT NULL,
	"excerpt" text,
	"body" text NOT NULL,
	"hero_image" varchar(512),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"premium_only" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"author_id" integer,
	"views" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"slug" varchar(191) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcements" ADD CONSTRAINT "announcements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_article_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."article_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pages" ADD CONSTRAINT "pages_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_site_idx" ON "announcements" USING btree ("site_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "article_categories_site_slug_unique" ON "article_categories" USING btree ("site_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "articles_site_slug_unique" ON "articles" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_site_status_idx" ON "articles" USING btree ("site_id","status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pages_site_slug_unique" ON "pages" USING btree ("site_id","slug");