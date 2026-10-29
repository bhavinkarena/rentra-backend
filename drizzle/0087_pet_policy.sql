-- Story 3.8: ordinary pet policy per stay listing; NULL derives from the legacy yes/no flag.
ALTER TABLE "rentable" ADD COLUMN IF NOT EXISTS "pet_policy" jsonb;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN IF NOT EXISTS "pet_policy_version" integer DEFAULT 1 NOT NULL;
