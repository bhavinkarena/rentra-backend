-- Phase 6 of docs/DATABASE-REVIEW.md: every visit belongs to an order; the legacy copy of booking goes.

-- Pre-check: rows a legacy order cannot hold fail here with a clear message, not a bare constraint.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM booking b LEFT JOIN "user" u ON u.id = b.customer_id
   WHERE b.order_id IS NULL AND (b.units_booked <> 1 OR b.guests <= 0 OR u.role IS DISTINCT FROM 'customer');
  IF n > 0 THEN
    RAISE EXCEPTION '0047: % legacy bookings have units_booked<>1, guests<=0 or a non-customer account; fix them first', n;
  END IF;
END $$;--> statement-breakpoint

-- 1. Each orderless (legacy) booking gets its own order in the fail-closed 'legacy' state.
--    Nothing is inferred: payment and provenance stay as recorded, snapshots stay empty when absent.
INSERT INTO booking_order (reference, customer_id, rentable_id, state, currency, time_zone,
    pricing_version, policy_version, policy_snapshot, listing_snapshot,
    amount_rent_minor, amount_fee_minor, amount_deposit_minor, amount_advance_minor,
    payment_mode, visit_provenance, idempotency_key, request_hash, confirmed_at, created_at, updated_at)
SELECT 'LEGACY-' || b.reference, b.customer_id, b.rentable_id, 'legacy', 'INR', 'Asia/Kolkata',
  coalesce(b.pricing_version, 'legacy-v1'), coalesce(b.policy_version, 'legacy-v1'),
  coalesce(b.policy_snapshot, '{}'::jsonb), coalesce(b.listing_snapshot, jsonb_build_object('title', r.title)),
  coalesce(b.amount_rent_minor, b.amount_rent::bigint * 100),
  coalesce(b.amount_fee_minor, b.amount_fee::bigint * 100),
  coalesce(b.amount_deposit_minor, b.amount_deposit::bigint * 100),
  b.amount_advance_minor,
  b.payment_mode, b.visit_provenance,
  'legacy:' || b.id, encode(sha256(convert_to(b.id::text, 'UTF8')), 'hex'),
  b.confirmed_at, b.created_at, b.updated_at
FROM booking b JOIN rentable r ON r.id = b.rentable_id
WHERE b.order_id IS NULL;--> statement-breakpoint

UPDATE booking b SET order_id = o.id, item_position = 1,
  local_day = coalesce(b.local_day, b.day), currency = 'INR', time_zone = 'Asia/Kolkata',
  amount_rent_minor = coalesce(b.amount_rent_minor, b.amount_rent::bigint * 100),
  amount_fee_minor = coalesce(b.amount_fee_minor, b.amount_fee::bigint * 100),
  amount_deposit_minor = coalesce(b.amount_deposit_minor, b.amount_deposit::bigint * 100)
FROM booking_order o
WHERE b.order_id IS NULL AND o.reference = 'LEGACY-' || b.reference AND o.state = 'legacy';--> statement-breakpoint

ALTER TABLE booking
  ALTER COLUMN order_id SET NOT NULL,
  ALTER COLUMN item_position SET NOT NULL,
  ALTER COLUMN local_day SET NOT NULL,
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN time_zone SET NOT NULL,
  ALTER COLUMN amount_rent_minor SET NOT NULL,
  ALTER COLUMN amount_fee_minor SET NOT NULL,
  ALTER COLUMN amount_deposit_minor SET NOT NULL;--> statement-breakpoint

-- 2. The legacy copy: rupee amounts, the duplicate date, snapshots and versions copied from the order,
--    and cash-on-arrival / check-in fields that only seeds ever wrote.
DROP INDEX booking_rentable_day_idx;--> statement-breakpoint
ALTER TABLE booking
  DROP COLUMN day,
  DROP COLUMN amount_rent,
  DROP COLUMN amount_fee,
  DROP COLUMN amount_deposit,
  DROP COLUMN amount_advance_paid,
  DROP COLUMN balance_mode,
  DROP COLUMN balance_settled_at,
  DROP COLUMN check_in_code,
  DROP COLUMN listing_snapshot,
  DROP COLUMN policy_snapshot,
  DROP COLUMN price_snapshot,
  DROP COLUMN pricing_version,
  DROP COLUMN policy_version;--> statement-breakpoint
DROP TYPE balance_mode;--> statement-breakpoint
CREATE INDEX booking_rentable_day_idx ON booking (rentable_id, local_day);--> statement-breakpoint

CREATE OR REPLACE FUNCTION rentra_checkout_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; pinned boolean; mutable text[];
BEGIN
  IF TG_TABLE_NAME='booking_order' THEN
    parent_id=OLD.id;
    mutable=ARRAY['state','confirmed_at','updated_at'];
  ELSE
    parent_id=OLD.order_id;
    mutable=ARRAY['state','confirmed_at','cancelled_at','cancelled_by_kind','cancellation_reason','updated_at','lifecycle_version'];
  END IF;
  SELECT EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=parent_id) INTO pinned;
  IF pinned AND (TG_OP='DELETE' OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)) THEN
    RAISE EXCEPTION 'Accepted checkout terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
