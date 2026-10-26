CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" varchar(16),
	"last_result" jsonb,
	"last_error" text,
	"runs" integer DEFAULT 0 NOT NULL
);
