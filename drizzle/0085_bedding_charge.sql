-- Story 3.4: the extra adult price may already include bedding (charges live in room_type.extra_places).
ALTER TABLE "room_type" ADD COLUMN IF NOT EXISTS "extra_adult_includes_bedding" boolean DEFAULT false NOT NULL;
