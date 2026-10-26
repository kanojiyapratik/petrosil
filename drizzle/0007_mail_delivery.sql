DROP INDEX IF EXISTS "mail_outbox_pending_idx";--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "provider_message_id" varchar(191);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_outbox_pending_idx" ON "mail_outbox" USING btree ("sent_at","failed_at","next_attempt_at","id");