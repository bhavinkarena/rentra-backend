-- Story 2.12: immediate global/owner settings; a NULL owner mode clears inheritance.
CREATE TABLE payout_mode_setting (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid REFERENCES "user"(id) ON DELETE RESTRICT,
  mode text CHECK (mode IN ('auto','manual')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 4 AND 500),
  created_by uuid REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_id IS NOT NULL OR mode IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX payout_mode_scope_idx ON payout_mode_setting(owner_id,version DESC);
--> statement-breakpoint
CREATE TRIGGER payout_mode_immutable BEFORE UPDATE OR DELETE ON payout_mode_setting
  FOR EACH ROW EXECUTE FUNCTION service_fee_setting_immutable();
--> statement-breakpoint
INSERT INTO payout_mode_setting(mode,reason) VALUES ('auto','Launch default payout mode (FR13/AD9)');
--> statement-breakpoint
-- Historical statement terms and unfunded payout destination snapshots stay pinned too.
CREATE TRIGGER payout_run_immutable BEFORE UPDATE OR DELETE ON payout_run
  FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('status');
--> statement-breakpoint
CREATE TRIGGER payout_terms_immutable BEFORE UPDATE OR DELETE ON payout
  FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('status','utr','settled_at');
--> statement-breakpoint
-- A late capture on an expired/cancelled hold is not confirmation. A cancellation
-- needs the supported policy settlement receipt as well as prior confirmation.
-- Text comparisons also support upgrades that add no_show in this same transaction.
CREATE FUNCTION rentra_payout_booking_supported(visit uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM booking b JOIN booking_order bo ON bo.id=b.order_id WHERE b.id=visit
    AND ((b.state::text IN ('confirmed','handed_over','returned','completed','no_show')
      AND bo.state::text IN ('confirmed','partially_cancelled','completed'))
    OR (b.state::text='cancelled' AND EXISTS (SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=bo.id AND e.kind='confirmed')
      AND EXISTS (SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
        WHERE c.order_id=bo.id AND v->>'id'=b.id::text))))
$$;
--> statement-breakpoint
CREATE FUNCTION rentra_payout_rent_capture_count(visit uuid, capture_environment text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM payment_allocation pa JOIN payment_transaction t ON t.id=pa.transaction_id
  WHERE pa.booking_id=visit AND pa.component='rent' AND t.kind='capture' AND t.outcome='succeeded'
    AND t.verified_at IS NOT NULL AND t.mode='real' AND t.environment::text=capture_environment
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_financial_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
DECLARE po payment_order; bo booking_order; a payment_attempt; t payment_transaction;
  b booking; pa payment_allocation; r refund; m customer_payment_method;
BEGIN
  IF TG_TABLE_NAME = 'payment_order' THEN
    IF TG_OP='INSERT' THEN
      SELECT * INTO STRICT bo FROM booking_order WHERE id=NEW.booking_order_id FOR UPDATE;
    ELSE
      SELECT * INTO STRICT bo FROM booking_order WHERE id=NEW.booking_order_id;
    END IF;
    IF (bo.currency, bo.payment_mode) IS DISTINCT FROM (NEW.currency, NEW.mode) THEN
      RAISE EXCEPTION 'Payment order scope mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
      RAISE EXCEPTION 'Provider order identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_attempt' THEN
    UPDATE payment_order SET state=state WHERE id=NEW.payment_order_id RETURNING * INTO STRICT po;
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency,NEW.expected_minor)
      IS DISTINCT FROM (po.provider,po.environment,po.mode,po.currency,po.expected_minor) THEN
      RAISE EXCEPTION 'Attempt scope mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
      RAISE EXCEPTION 'Provider payment identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.method_id IS NOT NULL THEN
      SELECT * INTO STRICT m FROM customer_payment_method WHERE id=NEW.method_id;
      SELECT * INTO STRICT bo FROM booking_order WHERE id=po.booking_order_id;
      IF (m.customer_id,m.provider,m.environment) IS DISTINCT FROM (bo.customer_id,po.provider,po.environment) OR NOT m.is_active THEN
        RAISE EXCEPTION 'Payment method ownership/scope mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_transaction' THEN
    SELECT * INTO STRICT a FROM payment_attempt WHERE id=NEW.attempt_id;
    UPDATE payment_order SET state=state WHERE id=a.payment_order_id RETURNING * INTO STRICT po;
    -- Re-read after the lock: identity may have been assigned by the preceding writer.
    SELECT * INTO STRICT a FROM payment_attempt WHERE id=NEW.attempt_id;
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency,NEW.expected_minor,NEW.provider_payment_id)
      IS DISTINCT FROM (a.provider,a.environment,a.mode,a.currency,a.expected_minor,a.provider_payment_id) THEN
      RAISE EXCEPTION 'Transaction scope mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_allocation' THEN
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'refund' THEN
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'refund_allocation' THEN
    SELECT * INTO STRICT r FROM refund WHERE id=NEW.refund_id;
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=r.transaction_id;
  ELSIF TG_TABLE_NAME = 'payout' THEN
    IF TG_OP='UPDATE' AND OLD.funding_allocation_id IS NOT NULL AND
      (to_jsonb(NEW)-ARRAY['status','utr','settled_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','utr','settled_at']) THEN
      RAISE EXCEPTION 'Funded payout terms are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.funding_allocation_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO STRICT pa FROM payment_allocation WHERE id=NEW.funding_allocation_id;
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=pa.transaction_id;
  END IF;
  SELECT * INTO STRICT a FROM payment_attempt WHERE id=t.attempt_id;
  UPDATE payment_order SET state=state WHERE id=a.payment_order_id RETURNING * INTO STRICT po;
  IF TG_TABLE_NAME = 'payment_allocation' THEN
    SELECT * INTO STRICT b FROM booking WHERE id=NEW.booking_id;
    IF b.order_id IS DISTINCT FROM po.booking_order_id OR b.payment_mode<>po.mode OR b.currency<>po.currency OR t.kind NOT IN ('capture','simulated')
      OR (t.mode='simulated' AND NEW.actual_minor<>0) OR (t.mode='real' AND NEW.simulated_minor<>0) THEN
      RAISE EXCEPTION 'Allocation source/visit mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'refund' THEN
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency) IS DISTINCT FROM (t.provider,t.environment,t.mode,t.currency)
      OR t.kind NOT IN ('capture','simulated') THEN
      RAISE EXCEPTION 'Refund source mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND ((OLD.state='succeeded' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
      OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id)) THEN
      RAISE EXCEPTION 'Completed refund or provider identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'refund_allocation' THEN
    SELECT * INTO STRICT r FROM refund WHERE id=NEW.refund_id;
    SELECT * INTO STRICT pa FROM payment_allocation WHERE id=NEW.payment_allocation_id;
    IF (pa.transaction_id,pa.booking_id,pa.component) IS DISTINCT FROM (r.transaction_id,NEW.booking_id,NEW.component)
      OR (r.mode='simulated' AND NEW.actual_minor<>0) THEN
      RAISE EXCEPTION 'Refund allocation source mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND NEW.actual_minor < OLD.actual_minor THEN
      RAISE EXCEPTION 'Actual refund cannot be reversed' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'payout' THEN
    SELECT * INTO STRICT b FROM booking WHERE id=pa.booking_id;
    SELECT * INTO STRICT bo FROM booking_order WHERE id=po.booking_order_id;
    IF t.mode<>'real' OR t.environment<>'live' OR t.kind<>'capture' OR t.verified_at IS NULL
      OR NOT (pa.component='rent' OR (b.slot::text='stay' AND pa.component='tax'))
      OR b.visit_provenance<>'real' OR bo.visit_provenance<>'real'
      OR b.payment_mode<>'real' OR bo.payment_mode<>'real'
      OR t.outcome<>'succeeded' OR NEW.booking_id<>b.id
      -- Existing funded obligations keep their pinned identity even without a modern owner snapshot.
      OR (TG_OP='INSERT' AND (NOT rentra_payout_booking_supported(b.id)
        OR (b.slot::text='stay' AND rentra_payout_rent_capture_count(b.id,t.environment::text)<>1)
        OR bo.listing_snapshot->>'ownerId' IS DISTINCT FROM NEW.client_id::text
        OR NOT EXISTS (SELECT 1 FROM "user" WHERE id=NEW.client_id AND role='client' AND account_status='active'))) THEN
      RAISE EXCEPTION 'Payout requires eligible verified rent capture' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
