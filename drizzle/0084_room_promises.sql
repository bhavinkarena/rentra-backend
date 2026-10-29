-- Story 3.3: room promises. Extra sleeping places, per-plan meal inclusions (null = code default)
-- and the room as booked, so later owner edits never rewrite an accepted stay.
ALTER TABLE "room_type" ADD COLUMN IF NOT EXISTS "extra_places" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_plan" ADD COLUMN IF NOT EXISTS "inclusions" jsonb;--> statement-breakpoint
ALTER TABLE "booking_room" ADD COLUMN IF NOT EXISTS "room_snapshot" jsonb;
