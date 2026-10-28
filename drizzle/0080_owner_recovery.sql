-- Story 2.17: Test-only owner recovery obligation after a guest rent refund that followed a succeeded payout fixture.
-- Records responsibility only: no money movement, no payout offset, no guest refund or fixture change.
CREATE TABLE owner_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL UNIQUE REFERENCES payment_allocation(id) ON DELETE RESTRICT,
  fixture_id uuid NOT NULL UNIQUE REFERENCES payout_transfer_fixture(id) ON DELETE RESTRICT,
  environment text NOT NULL DEFAULT 'test' CHECK (environment='test'),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
  obligation_minor bigint NOT NULL CHECK (obligation_minor BETWEEN 0 AND 9007199254740991),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor BETWEEN 0 AND 9007199254740991),
  recovered_minor bigint NOT NULL DEFAULT 0 CHECK (recovered_minor BETWEEN 0 AND 9007199254740991),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  actor_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE owner_recovery_adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_id uuid NOT NULL REFERENCES owner_recovery(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version>=1),
  "before" jsonb,
  "after" jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_key),
  UNIQUE(recovery_id,version)
);
--> statement-breakpoint
CREATE FUNCTION rentra_owner_recovery_adjustment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Owner recovery adjustments are append-only' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER owner_recovery_adjustment_append_only BEFORE UPDATE OR DELETE ON owner_recovery_adjustment
  FOR EACH ROW EXECUTE FUNCTION rentra_owner_recovery_adjustment_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_recovery_adjustment_no_truncate BEFORE TRUNCATE ON owner_recovery_adjustment
  FOR EACH STATEMENT EXECUTE FUNCTION rentra_owner_recovery_adjustment_append_only();
