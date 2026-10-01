-- Entertainment plan, Phase 3: top-level verticals (Farmhouse / Entertainment).
-- Hand-written: drizzle/meta snapshots stop at 0039, never run db:generate.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM category WHERE form::text <> 'fixed' OR default_rental_unit::text <> 'slot') THEN
    RAISE EXCEPTION '0052: a category is not a fixed slot category; tag verticals manually first';
  END IF;
  IF EXISTS (SELECT 1 FROM rentable WHERE rental_unit::text <> 'slot') THEN
    RAISE EXCEPTION '0052: a rentable is not slot-booked; review before tagging verticals';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE vertical (
  code varchar(24) PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  slug varchar(40) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name varchar(60) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'hidden' CHECK (status IN ('hidden', 'partners', 'public')),
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO vertical (code, slug, name, status, sort_order) VALUES
  ('farmhouse', 'farmhouse', 'Farmhouse', 'public', 10),
  ('entertainment', 'entertainment', 'Entertainment', 'hidden', 20);
--> statement-breakpoint
-- Default keeps every existing category writer valid; admin must pass the vertical explicitly from Phase 4.
ALTER TABLE category ADD COLUMN vertical_code varchar(24) NOT NULL DEFAULT 'farmhouse'
  REFERENCES vertical(code) ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE category ADD COLUMN icon_key varchar(40) CHECK (icon_key IS NULL OR icon_key ~ '^[a-z0-9_]{1,40}$');
--> statement-breakpoint
UPDATE category SET icon_key = 'farmhouse' WHERE icon_key IS NULL;
--> statement-breakpoint
CREATE INDEX category_vertical_idx ON category (vertical_code, is_active, sort_order);
--> statement-breakpoint
CREATE TABLE amenity_vertical (
  amenity_id uuid NOT NULL REFERENCES amenity(id) ON DELETE CASCADE,
  vertical_code varchar(24) NOT NULL REFERENCES vertical(code) ON DELETE RESTRICT,
  PRIMARY KEY (amenity_id, vertical_code)
);
--> statement-breakpoint
CREATE INDEX amenity_vertical_vertical_idx ON amenity_vertical (vertical_code);
--> statement-breakpoint
INSERT INTO amenity_vertical (amenity_id, vertical_code) SELECT id, 'farmhouse' FROM amenity;
