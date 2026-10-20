-- Hotel plan, Phase 2: the Hotels vertical (hidden), room types, rate plans, nightly inventory and booking lines.
-- Hand-written (snapshots stop at 0039). drizzle-orm applies every pending migration in ONE transaction, so the
-- booking_slot value 'stay' added here is never used as an enum literal in this release's SQL (55P04).
-- Overbooking is refused by the database: booking_room triggers keep room_night.sold/held, and
-- room_night_capacity_chk rejects sold + held > allotment for every writer, inside or outside the listing mutex.
ALTER TYPE booking_slot ADD VALUE IF NOT EXISTS 'stay';
--> statement-breakpoint
INSERT INTO vertical (code, slug, name, status, sort_order) VALUES ('hotel', 'hotels', 'Hotels', 'hidden', 30);
--> statement-breakpoint
-- A hotel is a rentable whose category is in the hotel vertical and is booked by the night.
CREATE FUNCTION hotel_listing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM rentable r JOIN category c ON c.id = r.category_id
    WHERE r.id = NEW.rentable_id AND c.vertical_code = 'hotel' AND r.rental_unit::text = 'night' FOR SHARE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only hotel listings have hotel details and room types' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE hotel_profile (
  rentable_id uuid PRIMARY KEY REFERENCES rentable(id) ON DELETE CASCADE,
  star_rating smallint CHECK (star_rating BETWEEN 1 AND 5),
  check_in_minute smallint NOT NULL DEFAULT 720 CHECK (check_in_minute BETWEEN 0 AND 1439),
  check_out_minute smallint NOT NULL DEFAULT 660 CHECK (check_out_minute BETWEEN 0 AND 1439),
  child_free_age smallint NOT NULL DEFAULT 5 CHECK (child_free_age BETWEEN 0 AND 17),
  -- Day numbers as Date#getUTCDay (0 = Sunday) of NIGHTS priced as weekend; Friday and Saturday by default.
  weekend_nights smallint[] NOT NULL DEFAULT '{5,6}' CHECK (weekend_nights <@ '{0,1,2,3,4,5,6}'::smallint[]),
  policies jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policies) = 'object'),
  gst_registered boolean NOT NULL DEFAULT false,
  gstin varchar(15) CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  show_exact_address boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_profile_gstin_chk CHECK (gst_registered = (gstin IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE room_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rentable_id uuid NOT NULL REFERENCES rentable(id) ON DELETE RESTRICT,
  name varchar(60) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  beds jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(beds) = 'array'),
  size_sqm smallint CHECK (size_sqm BETWEEN 4 AND 2000),
  view varchar(24),
  max_adults smallint NOT NULL CHECK (max_adults BETWEEN 1 AND 12),
  max_children smallint NOT NULL DEFAULT 0 CHECK (max_children BETWEEN 0 AND 12),
  max_occupancy smallint NOT NULL CHECK (max_occupancy BETWEEN 1 AND 16),
  base_occupancy smallint NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
  room_count smallint NOT NULL CHECK (room_count BETWEEN 1 AND 500),
  extra_adult_minor bigint NOT NULL DEFAULT 0 CHECK (extra_adult_minor BETWEEN 0 AND 5000000),
  extra_child_minor bigint NOT NULL DEFAULT 0 CHECK (extra_child_minor BETWEEN 0 AND 5000000),
  amenities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(amenities) = 'array'),
  photos jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photos) = 'array'),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_type_occupancy_chk CHECK (base_occupancy <= max_occupancy AND max_adults <= max_occupancy)
);
--> statement-breakpoint
CREATE UNIQUE INDEX room_type_id_rentable_idx ON room_type (id, rentable_id);
--> statement-breakpoint
CREATE UNIQUE INDEX room_type_name_idx ON room_type (rentable_id, lower(name));
--> statement-breakpoint
CREATE INDEX room_type_active_idx ON room_type (rentable_id, sort_order) WHERE is_active;
--> statement-breakpoint
CREATE TRIGGER hotel_profile_listing_guard BEFORE INSERT OR UPDATE OF rentable_id ON hotel_profile
  FOR EACH ROW EXECUTE FUNCTION hotel_listing_guard();
--> statement-breakpoint
CREATE TRIGGER room_type_listing_guard BEFORE INSERT OR UPDATE OF rentable_id ON room_type
  FOR EACH ROW EXECUTE FUNCTION hotel_listing_guard();
--> statement-breakpoint
-- A base plan has its own weekday/weekend prices; a derived plan follows one base plan of the same room type
-- (± basis points, + per guest per night). Cancellation: free until free_cancel_hours before check-in
-- (NULL = never free), then late_charge; no_show applies after check-in.
CREATE TABLE rate_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id uuid NOT NULL,
  rentable_id uuid NOT NULL,
  name varchar(60) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  meal_plan varchar(2) NOT NULL DEFAULT 'EP' CHECK (meal_plan IN ('EP', 'CP', 'MP', 'AP')),
  weekday_minor bigint CHECK (weekday_minor BETWEEN 30000 AND 20000000),
  weekend_minor bigint CHECK (weekend_minor BETWEEN 30000 AND 20000000),
  derived_from uuid,
  derived_pct_bps integer NOT NULL DEFAULT 0 CHECK (derived_pct_bps BETWEEN -5000 AND 5000),
  derived_per_guest_minor bigint NOT NULL DEFAULT 0 CHECK (derived_per_guest_minor BETWEEN 0 AND 1000000),
  free_cancel_hours smallint CHECK (free_cancel_hours BETWEEN 1 AND 720),
  late_charge varchar(12) NOT NULL DEFAULT 'first_night' CHECK (late_charge IN ('first_night', 'full_stay')),
  no_show varchar(12) NOT NULL DEFAULT 'first_night' CHECK (no_show IN ('first_night', 'full_stay')),
  min_nights smallint NOT NULL DEFAULT 1 CHECK (min_nights BETWEEN 1 AND 30),
  max_nights smallint NOT NULL DEFAULT 30 CHECK (max_nights BETWEEN 1 AND 30),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_plan_room_fk FOREIGN KEY (room_type_id, rentable_id) REFERENCES room_type (id, rentable_id) ON DELETE CASCADE,
  CONSTRAINT rate_plan_nights_chk CHECK (min_nights <= max_nights),
  CONSTRAINT rate_plan_kind_chk CHECK (CASE WHEN derived_from IS NULL
    THEN weekday_minor IS NOT NULL AND weekend_minor IS NOT NULL AND derived_pct_bps = 0 AND derived_per_guest_minor = 0
    ELSE weekday_minor IS NULL AND weekend_minor IS NULL AND derived_from <> id END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX rate_plan_id_room_idx ON rate_plan (id, room_type_id);
--> statement-breakpoint
ALTER TABLE rate_plan ADD CONSTRAINT rate_plan_parent_fk FOREIGN KEY (derived_from, room_type_id)
  REFERENCES rate_plan (id, room_type_id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX rate_plan_room_idx ON rate_plan (room_type_id, sort_order) WHERE is_active;
--> statement-breakpoint
-- One level only: a derived plan's parent is a base plan, and a plan with children stays a base plan.
CREATE FUNCTION rate_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.derived_from IS NOT NULL THEN
    PERFORM 1 FROM rate_plan WHERE id = NEW.derived_from AND derived_from IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'A plan can only follow a base plan' USING ERRCODE = '23514'; END IF;
    PERFORM 1 FROM rate_plan WHERE derived_from = NEW.id;
    IF FOUND THEN RAISE EXCEPTION 'Other plans follow this plan, so it must keep its own prices' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rate_plan_parent_guard BEFORE INSERT OR UPDATE OF derived_from ON rate_plan
  FOR EACH ROW EXECUTE FUNCTION rate_plan_guard();
--> statement-breakpoint
-- Date prices for base plans only. Calendar edits: no content version bump (like owner calendar prices).
CREATE TABLE rate_override (
  rate_plan_id uuid NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
  night date NOT NULL,
  rate_minor bigint NOT NULL CHECK (rate_minor BETWEEN 30000 AND 20000000),
  PRIMARY KEY (rate_plan_id, night)
);
--> statement-breakpoint
CREATE FUNCTION rate_override_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM rate_plan WHERE id = NEW.rate_plan_id AND derived_from IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Set date prices on the base plan' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rate_override_base_guard BEFORE INSERT OR UPDATE OF rate_plan_id ON rate_override
  FOR EACH ROW EXECUTE FUNCTION rate_override_guard();
--> statement-breakpoint
-- Rows exist only for nights that were booked or edited; a missing row means allotment = room_count, nothing
-- sold, open. allotment counts every room Rentra may sell that night, sold and held included.
CREATE TABLE room_night (
  room_type_id uuid NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  night date NOT NULL,
  allotment smallint NOT NULL CHECK (allotment >= 0),
  allotment_overridden boolean NOT NULL DEFAULT false,
  sold smallint NOT NULL DEFAULT 0 CHECK (sold >= 0),
  held smallint NOT NULL DEFAULT 0 CHECK (held >= 0),
  stop_sell boolean NOT NULL DEFAULT false,
  closed_to_arrival boolean NOT NULL DEFAULT false,
  min_nights smallint CHECK (min_nights BETWEEN 1 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, night),
  CONSTRAINT room_night_capacity_chk CHECK (sold + held <= allotment)
);
--> statement-breakpoint
CREATE FUNCTION room_night_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM room_type WHERE id = NEW.room_type_id AND NEW.allotment <= room_count;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rooms to sell cannot exceed the rooms of this type' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER room_night_allotment_guard BEFORE INSERT OR UPDATE OF allotment ON room_night
  FOR EACH ROW EXECUTE FUNCTION room_night_guard();
--> statement-breakpoint
-- Changing the number of rooms re-bases every future night that the owner did not set by hand; a night that
-- would drop below what is sold and held fails room_night_capacity_chk, so the change is refused.
CREATE FUNCTION room_type_count_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE room_night SET allotment = CASE WHEN allotment_overridden THEN LEAST(allotment, NEW.room_count) ELSE NEW.room_count END,
    updated_at = now()
  WHERE room_type_id = NEW.id AND night >= (now() AT TIME ZONE 'Asia/Kolkata')::date;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER room_type_count_sync AFTER UPDATE OF room_count ON room_type
  FOR EACH ROW WHEN (NEW.room_count IS DISTINCT FROM OLD.room_count) EXECUTE FUNCTION room_type_count_sync();
--> statement-breakpoint
-- One row per room booked. A stay is one booking (slot 'stay', local_day = check-in); its rooms are these rows.
-- held -> booked -> stayed | no_show; held | booked -> released (expired, failed or cancelled).
CREATE TABLE booking_room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL,
  rentable_id uuid NOT NULL,
  room_type_id uuid NOT NULL,
  rate_plan_id uuid NOT NULL,
  check_in date NOT NULL,
  check_out date NOT NULL,
  adults smallint NOT NULL CHECK (adults BETWEEN 1 AND 12),
  child_ages smallint[] NOT NULL DEFAULT '{}' CHECK (cardinality(child_ages) <= 12 AND 0 <= ALL (child_ages) AND 17 >= ALL (child_ages)),
  guest_name varchar(80),
  nights jsonb NOT NULL CHECK (jsonb_typeof(nights) = 'array'),
  amount_room_minor bigint NOT NULL CHECK (amount_room_minor BETWEEN 0 AND 9007199254740991),
  amount_tax_minor bigint NOT NULL CHECK (amount_tax_minor BETWEEN 0 AND 9007199254740991),
  plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'object'),
  state varchar(12) NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'booked', 'stayed', 'no_show', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_room_stay_chk CHECK (check_out > check_in AND check_out <= check_in + 30),
  CONSTRAINT booking_room_booking_fk FOREIGN KEY (booking_id, rentable_id) REFERENCES booking (id, rentable_id) ON DELETE RESTRICT,
  CONSTRAINT booking_room_type_fk FOREIGN KEY (room_type_id, rentable_id) REFERENCES room_type (id, rentable_id) ON DELETE RESTRICT,
  CONSTRAINT booking_room_plan_fk FOREIGN KEY (rate_plan_id, room_type_id) REFERENCES rate_plan (id, room_type_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX booking_room_booking_idx ON booking_room (booking_id);
--> statement-breakpoint
CREATE INDEX booking_room_type_stay_idx ON booking_room (room_type_id, check_in) WHERE state <> 'released';
--> statement-breakpoint
CREATE FUNCTION booking_room_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line booking_room; was text; now_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.room_type_id, NEW.check_in, NEW.check_out, NEW.booking_id)
      IS DISTINCT FROM (OLD.room_type_id, OLD.check_in, OLD.check_out, OLD.booking_id) THEN
    RAISE EXCEPTION 'A booked room cannot move; release it and book again' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
  was := CASE WHEN TG_OP = 'INSERT' OR OLD.state = 'released' THEN NULL WHEN OLD.state = 'held' THEN 'held' ELSE 'sold' END;
  now_kind := CASE WHEN TG_OP = 'DELETE' OR NEW.state = 'released' THEN NULL WHEN NEW.state = 'held' THEN 'held' ELSE 'sold' END;
  IF TG_OP = 'UPDATE' AND OLD.state = 'released' AND NEW.state <> 'released' THEN
    RAISE EXCEPTION 'A released room cannot be booked again' USING ERRCODE = '23514';
  END IF;
  IF was IS NOT DISTINCT FROM now_kind THEN RETURN NULL; END IF;
  IF now_kind IS NOT NULL THEN
    INSERT INTO room_night (room_type_id, night, allotment)
    SELECT line.room_type_id, d::date, rt.room_count
    FROM room_type rt, generate_series(line.check_in, line.check_out - 1, interval '1 day') d
    WHERE rt.id = line.room_type_id
    ON CONFLICT DO NOTHING;
  END IF;
  -- Nights are updated in key order so two writers never lock them in opposite orders.
  UPDATE room_night rn SET
    held = rn.held + (now_kind IS NOT DISTINCT FROM 'held')::int - (was IS NOT DISTINCT FROM 'held')::int,
    sold = rn.sold + (now_kind IS NOT DISTINCT FROM 'sold')::int - (was IS NOT DISTINCT FROM 'sold')::int,
    updated_at = now()
  FROM (SELECT room_type_id, night FROM room_night WHERE room_type_id = line.room_type_id
          AND night >= line.check_in AND night < line.check_out ORDER BY night FOR UPDATE) k
  WHERE rn.room_type_id = k.room_type_id AND rn.night = k.night;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM room_night WHERE room_type_id = line.room_type_id
      AND night >= line.check_in AND night < line.check_out AND stop_sell;
    IF FOUND THEN RAISE EXCEPTION 'This room type is closed on one of these nights' USING ERRCODE = '23514', CONSTRAINT = 'room_night_stop_sell'; END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_room_inventory AFTER INSERT OR UPDATE OR DELETE ON booking_room
  FOR EACH ROW EXECUTE FUNCTION booking_room_inventory();
--> statement-breakpoint
CREATE TRIGGER hotel_profile_content_version BEFORE INSERT OR UPDATE OR DELETE ON hotel_profile
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER room_type_content_version BEFORE INSERT OR UPDATE OR DELETE ON room_type
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER rate_plan_content_version BEFORE INSERT OR UPDATE OR DELETE ON rate_plan
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
-- Most specific active rule wins: property, then city, then vertical. No two rules overlap at the same scope.
CREATE TABLE commission_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_code varchar(24) NOT NULL REFERENCES vertical(code) ON DELETE RESTRICT,
  city_id uuid REFERENCES city(id) ON DELETE RESTRICT,
  rentable_id uuid REFERENCES rentable(id) ON DELETE RESTRICT,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 3000),
  tier varchar(16) NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'founding', 'preferred', 'chain')),
  valid_from date NOT NULL,
  valid_to date,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rule_scope_chk CHECK (city_id IS NULL OR rentable_id IS NULL),
  CONSTRAINT commission_rule_dates_chk CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT commission_rule_no_overlap EXCLUDE USING gist (
    vertical_code WITH =,
    (COALESCE(city_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (COALESCE(rentable_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&)
);
--> statement-breakpoint
-- Tax per room per night, decided on the tariff actually charged. Effective-dated so a rate change is data.
CREATE TABLE tax_slab (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_code varchar(24) NOT NULL REFERENCES vertical(code) ON DELETE RESTRICT,
  min_rate_minor bigint NOT NULL CHECK (min_rate_minor >= 0),
  max_rate_minor bigint,
  tax_bps integer NOT NULL CHECK (tax_bps BETWEEN 0 AND 2800),
  effective_from date NOT NULL,
  effective_to date,
  note text NOT NULL DEFAULT '',
  CONSTRAINT tax_slab_rate_chk CHECK (max_rate_minor IS NULL OR max_rate_minor >= min_rate_minor),
  CONSTRAINT tax_slab_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT tax_slab_no_overlap EXCLUDE USING gist (
    vertical_code WITH =,
    int8range(min_rate_minor, max_rate_minor, '[]') WITH &&,
    daterange(effective_from, effective_to, '[]') WITH &&)
);
--> statement-breakpoint
-- GST on hotel accommodation from 22 Sep 2025 (to be confirmed by the CA in Phase 0).
INSERT INTO tax_slab (vertical_code, min_rate_minor, max_rate_minor, tax_bps, effective_from, note) VALUES
  ('hotel', 0, 750000, 500, '2025-09-22', 'GST 5% (no ITC): tariff up to Rs 7,500 per room per night'),
  ('hotel', 750001, NULL, 1800, '2025-09-22', 'GST 18%: tariff above Rs 7,500 per room per night');
