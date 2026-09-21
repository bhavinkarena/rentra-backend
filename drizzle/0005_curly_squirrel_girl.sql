ALTER TABLE "admin_user" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN "locked_until" timestamp with time zone;