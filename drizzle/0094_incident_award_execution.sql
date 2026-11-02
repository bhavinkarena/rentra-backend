-- Story 4.5: executing a saved incident award (Test only). One execution per decision; an
-- owner-funded award records the owner's extra share (reassigned Rentra fee + fee part of the new
-- refund) as an incident obligation. Rent stays with the 2.17 recovery path; tax is never in it.
-- Rollback (in this order):
--   DELETE FROM owner_repayment WHERE incident_obligation_id IS NOT NULL;
--   ALTER TABLE owner_repayment DROP CONSTRAINT owner_repayment_one_target, DROP COLUMN incident_obligation_id; -- drops its FK and index
--   ALTER TABLE owner_repayment ALTER COLUMN recovery_id SET NOT NULL;
--   DROP TABLE incident_remedy_execution; DROP TABLE incident_owner_obligation; DROP FUNCTION rentra_incident_obligation_guard();
-- State 'cancelled' is reserved: no cancel path exists in Story 4.5.
CREATE TABLE incident_owner_obligation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL UNIQUE REFERENCES incident_remedy_decision(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES booking_order(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  components jsonb NOT NULL CHECK (components ? 'reassigned_fee_minor' AND components ? 'owner_fee_share_minor'),
  state text NOT NULL DEFAULT 'awaiting_payout' CHECK (state IN ('awaiting_payout','due','repaid','cancelled')),
  environment text NOT NULL DEFAULT 'test' CHECK (environment='test'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,owner_id)
);
--> statement-breakpoint
-- Append-only apart from forward state transitions (audited by the service).
CREATE FUNCTION rentra_incident_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'incident_owner_obligation is append-only'; END IF;
  IF (to_jsonb(NEW)-'state'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'updated_at')
    OR NOT ((OLD.state='awaiting_payout' AND NEW.state IN ('due','cancelled'))
      OR (OLD.state='due' AND NEW.state IN ('repaid','cancelled'))
      OR OLD.state=NEW.state) THEN
    RAISE EXCEPTION 'incident_owner_obligation only moves state forward';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER incident_owner_obligation_guard BEFORE UPDATE OR DELETE ON incident_owner_obligation
  FOR EACH ROW EXECUTE FUNCTION rentra_incident_obligation_guard();
--> statement-breakpoint
CREATE INDEX incident_owner_obligation_order ON incident_owner_obligation(order_id) WHERE state='awaiting_payout';
--> statement-breakpoint
CREATE TABLE incident_remedy_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL UNIQUE REFERENCES incident_remedy_decision(id) ON DELETE RESTRICT,
  refund_ids uuid[] NOT NULL DEFAULT '{}',
  obligation_id uuid REFERENCES incident_owner_obligation(id) ON DELETE RESTRICT,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  executed_by uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE owner_repayment ALTER COLUMN recovery_id DROP NOT NULL,
  ADD COLUMN incident_obligation_id uuid,
  ADD CONSTRAINT owner_repayment_incident_fk FOREIGN KEY (incident_obligation_id,owner_id)
    REFERENCES incident_owner_obligation(id,owner_id) ON DELETE RESTRICT,
  ADD CONSTRAINT owner_repayment_one_target CHECK (num_nonnulls(recovery_id,incident_obligation_id)=1);
--> statement-breakpoint
CREATE UNIQUE INDEX owner_repayment_incident_one_open ON owner_repayment(incident_obligation_id) WHERE state='open';
