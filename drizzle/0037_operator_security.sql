ALTER TABLE "admin_user" ADD COLUMN "security_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN "enrollment_hash" text;--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN "enrollment_secret" text;--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN "enrollment_expires_at" timestamp with time zone;