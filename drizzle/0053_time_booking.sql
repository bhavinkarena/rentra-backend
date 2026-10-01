-- Entertainment plan, Phase 3: courts/lanes (resources), hourly rates, per-resource double-booking lock.
-- drizzle-orm applies every pending migration in ONE transaction. The enum values added here must not be
-- used as enum literals anywhere in this release's SQL (Postgres 55P04); compare through ::text instead.
ALTER TYPE rental_unit ADD VALUE IF NOT EXISTS 'hour';
--> statement-breakpoint
ALTER TYPE booking_slot ADD VALUE IF NOT EXISTS 'hourly';
--> statement-breakpoint
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'rent_agreement';
--> statement-breakpoint
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'shop_establishment';
--> statement-breakpoint
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'gst_certificate';
--> statement-breakpoint
CREATE TABLE rentable_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rentable_id uuid NOT NULL REFERENCES rentable(id) ON DELETE RESTRICT,
  name varchar(60) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  is_indoor boolean,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX rentable_resource_id_rentable_idx ON rentable_resource (id, rentable_id);
--> statement-breakpoint
CREATE UNIQUE INDEX rentable_resource_name_idx ON rentable_resource (rentable_id, lower(name));
--> statement-breakpoint
CREATE INDEX rentable_resource_active_idx ON rentable_resource (rentable_id, sort_order) WHERE is_active;
--> statement-breakpoint
CREATE TABLE rentable_resource_activity (
  resource_id uuid NOT NULL,
  rentable_id uuid NOT NULL,
  category_id uuid NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  PRIMARY KEY (resource_id, category_id),
  CONSTRAINT resource_activity_resource_fk FOREIGN KEY (resource_id, rentable_id)
    REFERENCES rentable_resource (id, rentable_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX resource_activity_category_idx ON rentable_resource_activity (category_id, rentable_id);
--> statement-breakpoint
CREATE TABLE rentable_rate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rentable_id uuid NOT NULL REFERENCES rentable(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  day_kind varchar(8) NOT NULL CHECK (day_kind IN ('weekday', 'weekend')),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute > start_minute AND end_minute <= 1800),
  hourly_rate_minor bigint NOT NULL CHECK (hourly_rate_minor BETWEEN 0 AND 50000000),
  CONSTRAINT rentable_rate_no_overlap EXCLUDE USING gist (
    rentable_id WITH =, category_id WITH =, day_kind WITH =, int4range(start_minute, end_minute) WITH &&)
);
--> statement-breakpoint
CREATE INDEX rentable_rate_lookup_idx ON rentable_rate (rentable_id, category_id, day_kind, start_minute);
--> statement-breakpoint
ALTER TABLE booking ADD COLUMN resource_id uuid;
--> statement-breakpoint
ALTER TABLE booking ADD CONSTRAINT booking_resource_fk FOREIGN KEY (resource_id, rentable_id)
  REFERENCES rentable_resource (id, rentable_id) ON DELETE RESTRICT;
--> statement-breakpoint
-- Text comparison on purpose: 'hourly' must not be parsed as booking_slot in this transaction (55P04).
ALTER TABLE booking ADD CONSTRAINT booking_resource_slot_chk CHECK ((slot::text = 'hourly') = (resource_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX booking_resource_start_idx ON booking (resource_id, starts_at) WHERE resource_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE inventory_reservation ADD COLUMN resource_id uuid;
--> statement-breakpoint
ALTER TABLE inventory_reservation ADD CONSTRAINT reservation_resource_fk FOREIGN KEY (resource_id, rentable_id)
  REFERENCES rentable_resource (id, rentable_id) ON DELETE RESTRICT;
--> statement-breakpoint
-- Drizzle does not model exclusion constraints: preserve this custom DDL in future migrations.
-- NULL resource = the whole listing (every farmhouse row, and venue-wide closures), mapped to one sentinel key.
ALTER TABLE inventory_reservation DROP CONSTRAINT reservation_active_overlap_excl;
--> statement-breakpoint
ALTER TABLE inventory_reservation ADD CONSTRAINT reservation_active_overlap_excl EXCLUDE USING gist (
  rentable_id WITH =,
  (COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  tstzrange(blocked_start_at, blocked_end_at, '[)') WITH &&
) WHERE (state IN ('held', 'committed'));
--> statement-breakpoint
CREATE TRIGGER resource_content_version BEFORE INSERT OR UPDATE OR DELETE ON rentable_resource
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER resource_activity_content_version BEFORE INSERT OR UPDATE OR DELETE ON rentable_resource_activity
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER rate_content_version BEFORE INSERT OR UPDATE OR DELETE ON rentable_rate
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE FUNCTION resource_activity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing_vertical varchar(24); listing_unit text;
BEGIN
  SELECT c.vertical_code, r.rental_unit::text INTO listing_vertical, listing_unit
    FROM rentable r JOIN category c ON c.id = r.category_id WHERE r.id = NEW.rentable_id;
  IF listing_unit IS DISTINCT FROM 'hour' THEN
    RAISE EXCEPTION 'Only time-booked listings have bookable resources' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM category WHERE id = NEW.category_id AND is_active
    AND vertical_code = listing_vertical AND default_rental_unit::text = 'hour' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active activity from this vertical' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_activity_reference_guard BEFORE INSERT OR UPDATE ON rentable_resource_activity
  FOR EACH ROW EXECUTE FUNCTION resource_activity_guard();
--> statement-breakpoint
-- Body of 0035 kept verbatim; added: booking model must match the category, a listing never changes
-- vertical, and an amenity must be scoped to the listing's vertical. All comparisons via ::text.
CREATE OR REPLACE FUNCTION catalogue_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_vertical varchar(24); old_vertical varchar(24); category_unit text;
BEGIN
 IF TG_TABLE_NAME = 'rentable' THEN
  IF TG_OP = 'INSERT' OR NEW.city_id IS DISTINCT FROM OLD.city_id OR NEW.area_id IS DISTINCT FROM OLD.area_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.rental_unit IS DISTINCT FROM OLD.rental_unit THEN
   PERFORM 1 FROM city WHERE id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM area WHERE id=NEW.area_id AND city_id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active area in this city' USING ERRCODE='23514'; END IF;
   SELECT vertical_code, default_rental_unit::text INTO new_vertical, category_unit
     FROM category WHERE id=NEW.category_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active category' USING ERRCODE='23514'; END IF;
   IF NEW.rental_unit::text IS DISTINCT FROM category_unit THEN
     RAISE EXCEPTION 'The listing booking model must match its category' USING ERRCODE='23514';
   END IF;
   IF TG_OP = 'UPDATE' AND NEW.category_id IS DISTINCT FROM OLD.category_id THEN
     SELECT vertical_code INTO old_vertical FROM category WHERE id=OLD.category_id;
     IF old_vertical IS DISTINCT FROM new_vertical THEN
       RAISE EXCEPTION 'A listing cannot move to another vertical' USING ERRCODE='23514';
     END IF;
   END IF;
  END IF;
 ELSE
  IF TG_OP = 'INSERT' OR NEW.amenity_id IS DISTINCT FROM OLD.amenity_id THEN
   PERFORM 1 FROM amenity WHERE id=NEW.amenity_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active amenity' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM amenity_vertical av JOIN category c ON c.vertical_code = av.vertical_code
     JOIN rentable r ON r.category_id = c.id
     WHERE r.id = NEW.rentable_id AND av.amenity_id = NEW.amenity_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'This amenity is not offered for this kind of listing' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
