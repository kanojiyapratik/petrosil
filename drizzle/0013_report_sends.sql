CREATE TABLE IF NOT EXISTS "mail_send_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"send_id" integer NOT NULL,
	"user_id" integer,
	"email" varchar(191) NOT NULL,
	"name" varchar(191),
	"outbox_id" integer,
	"open_token" varchar(64) NOT NULL,
	"opened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"about" varchar(512),
	"subject" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"sent_by" integer,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_send_recipients" ADD CONSTRAINT "mail_send_recipients_send_id_mail_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."mail_sends"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_send_recipients" ADD CONSTRAINT "mail_send_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_send_recipients" ADD CONSTRAINT "mail_send_recipients_outbox_id_mail_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."mail_outbox"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_send_recipients_token_unique" ON "mail_send_recipients" USING btree ("open_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_send_recipients_send_idx" ON "mail_send_recipients" USING btree ("send_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_sends_site_idx" ON "mail_sends" USING btree ("site_id","created_at");