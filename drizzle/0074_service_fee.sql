-- Story 2.2: one guest-paid Rentra service fee. A global rate, or an owner-wide override that
-- replaces it. Rows are append-only history; the row in force is the latest effective_at <= now.
-- No category or property scope exists by design.
CREATE TABLE service_fee_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES "user"(id),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 3000),
  effective_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 4 AND 500),
  created_by uuid REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX service_fee_setting_scope_idx ON service_fee_setting
  (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_at);--> statement-breakpoint
CREATE FUNCTION service_fee_setting_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'service fee settings are append-only history'; END; $$;--> statement-breakpoint
CREATE TRIGGER service_fee_setting_immutable BEFORE UPDATE OR DELETE ON service_fee_setting
  FOR EACH ROW EXECUTE FUNCTION service_fee_setting_immutable();--> statement-breakpoint
-- Launch default (PRD FR-12): 5% from the moment this migration runs. Accepted bookings keep theirs.
INSERT INTO service_fee_setting (owner_id, rate_bps, effective_at, reason)
  VALUES (NULL, 500, now(), 'Launch default service fee (PRD FR-12)');
