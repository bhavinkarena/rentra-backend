-- Story 3.6: explicit child age bands (property default + optional room override), cots per room, and a policy version.
ALTER TABLE "hotel_profile" ADD COLUMN IF NOT EXISTS "child_policy" jsonb;--> statement-breakpoint
ALTER TABLE "hotel_profile" ADD COLUMN IF NOT EXISTS "child_policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_type" ADD COLUMN IF NOT EXISTS "child_policy" jsonb;--> statement-breakpoint
ALTER TABLE "room_type" ADD COLUMN IF NOT EXISTS "cots" jsonb DEFAULT '{"count":0}'::jsonb NOT NULL;
