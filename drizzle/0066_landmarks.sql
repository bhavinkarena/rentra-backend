-- Hotel plan, Phase 6: landmarks for "hotels near Surat Railway Station" search and landing pages.
-- Plain latitude/longitude: distances are computed in the API from the hotel's map pin,
-- so search works the same with and without PostGIS.
CREATE TABLE landmark (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES city(id) ON DELETE RESTRICT,
  slug varchar(80) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name varchar(120) NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  kind varchar(16) NOT NULL CHECK (kind IN ('station', 'airport', 'temple', 'business', 'hospital', 'attraction', 'education', 'mall')),
  latitude numeric(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX landmark_city_idx ON landmark (city_id, sort_order) WHERE is_active;
