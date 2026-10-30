-- Story 3.10: whole apartments, one exclusive nightly unit under the stay (hotel) vertical.
-- 'unit_night' is never used as an enum literal here: db:migrate applies every pending file in ONE
-- transaction (55P04). The "Whole apartment" category row is seeded after commit by src/scripts/migrate.js.
ALTER TYPE rental_unit ADD VALUE IF NOT EXISTS 'unit_night';
--> statement-breakpoint
-- NULL beds / check_in_minute / weekday_minor: that part of the setup is not saved yet.
CREATE TABLE IF NOT EXISTS apartment_profile (
  rentable_id uuid PRIMARY KEY REFERENCES rentable(id) ON DELETE CASCADE,
  bedrooms smallint NOT NULL DEFAULT 1 CHECK (bedrooms BETWEEN 0 AND 20),
  bathrooms smallint NOT NULL DEFAULT 1 CHECK (bathrooms BETWEEN 1 AND 20),
  beds jsonb CHECK (beds IS NULL OR jsonb_typeof(beds) = 'array'),
  max_adults smallint NOT NULL DEFAULT 2 CHECK (max_adults BETWEEN 1 AND 30),
  max_children smallint NOT NULL DEFAULT 0 CHECK (max_children BETWEEN 0 AND 20),
  max_occupants smallint NOT NULL DEFAULT 2 CHECK (max_occupants >= max_adults),
  min_nights smallint NOT NULL DEFAULT 1 CHECK (min_nights BETWEEN 1 AND 90),
  max_nights smallint NOT NULL DEFAULT 30 CHECK (max_nights BETWEEN 1 AND 90),
  arrival_rules jsonb NOT NULL DEFAULT '{"weekdays":{},"ranges":[]}'::jsonb CHECK (jsonb_typeof(arrival_rules) = 'object'),
  check_in_minute smallint CHECK (check_in_minute BETWEEN 0 AND 1439),
  check_out_minute smallint CHECK (check_out_minute BETWEEN 0 AND 1439),
  turnover_nights smallint NOT NULL DEFAULT 0 CHECK (turnover_nights BETWEEN 0 AND 3),
  cleaning_fee_minor bigint NOT NULL DEFAULT 0 CHECK (cleaning_fee_minor BETWEEN 0 AND 5000000),
  weekday_minor bigint CHECK (weekday_minor BETWEEN 100 AND 50000000),
  weekend_minor bigint CHECK (weekend_minor BETWEEN 100 AND 50000000),
  -- Day numbers as Date#getUTCDay (0 = Sunday) of NIGHTS priced as weekend, like hotel_profile.
  weekend_nights smallint[] NOT NULL DEFAULT '{5,6}' CHECK (weekend_nights <@ '{0,1,2,3,4,5,6}'::smallint[]),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apartment_nights_chk CHECK (min_nights <= max_nights)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS apartment_profile_content_version ON apartment_profile;
--> statement-breakpoint
CREATE TRIGGER apartment_profile_content_version BEFORE INSERT OR UPDATE OR DELETE ON apartment_profile
  FOR EACH ROW EXECUTE FUNCTION version_listing_child();
