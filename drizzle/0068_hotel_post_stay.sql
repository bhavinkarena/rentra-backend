-- Hotel plan, Phase 8: reviews with sub-scores, weekly payout runs and hotel post-stay analytics.

ALTER TABLE review ADD COLUMN staff integer;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN location integer;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN comfort integer;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN facilities integer;
--> statement-breakpoint
ALTER TABLE review ADD COLUMN traveller_type text CHECK (traveller_type IS NULL OR traveller_type IN ('business','couple','family','friends','solo'));
--> statement-breakpoint
ALTER TABLE review DROP CONSTRAINT review_scores_chk;
--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_scores_chk CHECK (
  rating BETWEEN 1 AND 5
  AND (cleanliness IS NULL OR cleanliness BETWEEN 1 AND 5)
  AND (accuracy IS NULL OR accuracy BETWEEN 1 AND 5)
  AND (value_for_money IS NULL OR value_for_money BETWEEN 1 AND 5)
  AND (staff IS NULL OR staff BETWEEN 1 AND 5)
  AND (location IS NULL OR location BETWEEN 1 AND 5)
  AND (comfort IS NULL OR comfort BETWEEN 1 AND 5)
  AND (facilities IS NULL OR facilities BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.booking_id,NEW.rentable_id,NEW.author_id,NEW.author_role,NEW.rating,NEW.cleanliness,NEW.accuracy,NEW.value_for_money,NEW.body,NEW.staff,NEW.location,NEW.comfort,NEW.facilities,NEW.traveller_type)
    IS DISTINCT FROM (OLD.booking_id,OLD.rentable_id,OLD.author_id,OLD.author_role,OLD.rating,OLD.cleanliness,OLD.accuracy,OLD.value_for_money,OLD.body,OLD.staff,OLD.location,OLD.comfort,OLD.facilities,OLD.traveller_type) THEN
    RAISE EXCEPTION 'Submitted review content is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.author_role='customer' AND (TG_OP='INSERT' OR NEW.moderation_state='published') AND
    NOT rentra_review_eligible(NEW.booking_id,NEW.author_id,NEW.rentable_id) THEN
    RAISE EXCEPTION 'Actual completed visit required' USING ERRCODE='23514';
  END IF;
  IF NEW.moderation_state='published' AND (NEW.author_role<>'customer' OR NEW.moderated_by IS NULL OR NEW.moderated_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.moderated_by AND is_active)) THEN
    RAISE EXCEPTION 'Active moderator required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_eligible(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id
  WHERE b.id=visit AND b.customer_id=author AND b.rentable_id=listing AND r.client_id<>author
  AND b.order_id IS NOT NULL AND b.state='completed' AND b.visit_provenance='real' AND b.hours_known
  AND (b.ends_at IS NULL OR clock_timestamp() <= b.ends_at + interval '30 days')
  AND (b.slot::text='stay' OR (SELECT count(DISTINCT e.kind) FROM visit_evidence e WHERE e.booking_id=b.id AND e.nature='actual')=3))
$$;
--> statement-breakpoint
DROP VIEW IF EXISTS public_customer_review;
--> statement-breakpoint
CREATE VIEW public_customer_review AS
  SELECT r.* FROM review r WHERE r.author_role='customer' AND r.moderation_state='published' AND r.published_at IS NOT NULL
  AND rentra_review_eligible(r.booking_id,r.author_id,r.rentable_id);
--> statement-breakpoint
CREATE TABLE payout_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_number varchar(16) NOT NULL UNIQUE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  payout_date date NOT NULL,
  total_bookings integer NOT NULL DEFAULT 0,
  room_revenue_minor bigint NOT NULL DEFAULT 0,
  gst_collected_minor bigint NOT NULL DEFAULT 0,
  commission_minor bigint NOT NULL DEFAULT 0,
  commission_gst_minor bigint NOT NULL DEFAULT 0,
  tcs_minor bigint NOT NULL DEFAULT 0,
  tds_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','processing','completed','failed')),
  -- Live runs move money; test runs are statements only (Test captures are not real money).
  environment varchar(8) NOT NULL DEFAULT 'live' CHECK (environment IN ('live', 'test')),
  -- The statement exactly as executed: one line per stay (room, GST, commission + GST, TCS, TDS, net).
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  executed_by uuid REFERENCES admin_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX payout_run_date_idx ON payout_run (payout_date);
--> statement-breakpoint
ALTER TABLE payout ADD COLUMN payout_run_id uuid REFERENCES payout_run(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX payout_run_idx ON payout (payout_run_id) WHERE payout_run_id IS NOT NULL;
--> statement-breakpoint
-- Hotel stays are payable after check-in (or 24 hours after check-in time when not marked), and a
-- cancelled or no-show stay pays out what was kept. A GST-registered hotel's GST is passed through from
-- the stay's tax allocation. Every other visit keeps the existing rule (completed, rent only).
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
      OR NOT (b.state='completed' OR (b.slot::text='stay' AND (b.state IN ('handed_over','returned','no_show')
        OR (b.state IN ('confirmed','cancelled') AND b.starts_at + interval '24 hours' <= clock_timestamp()))))
      OR NEW.booking_id<>b.id OR NOT EXISTS (SELECT 1 FROM rentable WHERE id=b.rentable_id AND client_id=NEW.client_id) THEN
      RAISE EXCEPTION 'Payout requires eligible verified rent capture' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
