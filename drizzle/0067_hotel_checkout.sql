-- Hotel plan, Phase 7: checkout. A paid stay confirms its held rooms, and the order keeps the
-- guest details given at checkout (room guest names, arrival time, requests, GST invoice details).
CREATE OR REPLACE FUNCTION booking_room_follow_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state::text = 'confirmed' THEN
    UPDATE booking_room SET state = 'booked', updated_at = now() WHERE booking_id = NEW.id AND state = 'held';
  ELSIF NEW.state::text = 'cancelled' THEN
    UPDATE booking_room SET state = 'released', updated_at = now() WHERE booking_id = NEW.id AND state IN ('held', 'booked');
  ELSIF NEW.state::text = 'no_show' THEN
    UPDATE booking_room SET state = 'no_show', updated_at = now() WHERE booking_id = NEW.id AND state = 'booked';
  ELSIF NEW.state::text = 'completed' THEN
    UPDATE booking_room SET state = 'stayed', updated_at = now() WHERE booking_id = NEW.id AND state = 'booked';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE booking_order ADD COLUMN guest_details jsonb CHECK (guest_details IS NULL OR jsonb_typeof(guest_details) = 'object');
--> statement-breakpoint
-- Hotel stays are always prepaid in full, whatever the gateway's default collection (advance or full).
-- Every other checkout must still match the configured collection purpose.
CREATE OR REPLACE FUNCTION rentra_checkout_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_order; c payment_gateway_config; stay boolean;
BEGIN
  SELECT * INTO STRICT p FROM payment_order WHERE id=NEW.payment_order_id;
  SELECT * INTO STRICT c FROM payment_gateway_config WHERE version=NEW.config_version;
  SELECT coalesce(o.policy_snapshot->>'kind' = 'stay', false) INTO stay FROM booking_order o WHERE o.id=p.booking_order_id;
  IF (p.provider,p.environment::text,p.mode::text,p.currency) IS DISTINCT FROM ('razorpay','test','real','INR')
    OR p.purpose::text IS DISTINCT FROM (CASE WHEN stay THEN 'full' ELSE c.collection_purpose END)
    OR NOT c.enabled OR c.provider<>'razorpay' OR c.environment<>'test'
    OR NEW.snapshot->>'provider'<>'razorpay' OR NEW.snapshot->>'environment'<>'test'
    OR (NEW.snapshot->>'version')::int IS DISTINCT FROM c.version
    OR (NEW.snapshot->>'expectedMinor')::bigint IS DISTINCT FROM p.expected_minor
    OR NEW.snapshot->>'collectionPurpose' IS DISTINCT FROM p.purpose::text
    OR NEW.snapshot->>'mode' IS DISTINCT FROM 'real'
    OR NEW.snapshot->>'enabled' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Checkout execution scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
