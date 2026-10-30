-- Story 4.3: private notes need admin.support.read or write; guest-visible admin messages still need write.
-- Rollback: re-run the rentra_support_scope() body from 0056, its latest prior definition (0057-0091 do not redefine it).
CREATE OR REPLACE FUNCTION rentra_support_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant support_request%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='support_request' THEN
  IF NEW.state<>'open' OR NEW.version<>0 THEN RAISE EXCEPTION 'Invalid initial support state' USING ERRCODE='23514'; END IF;
  IF NEW.client_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.client_id AND role='client' AND (account_status='active' OR (account_status='pending_application' AND NEW.category IN ('verification','account','other') AND NEW.order_id IS NULL AND NEW.property_id IS NULL AND NEW.privacy_request_id IS NULL)))
    OR (NEW.property_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentable WHERE id=NEW.property_id AND client_id=NEW.client_id))
    OR (NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=NEW.order_id AND r.client_id=NEW.client_id AND (NEW.property_id IS NULL OR NEW.property_id=r.id)))
   THEN RAISE EXCEPTION 'Invalid support client scope' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.customer_id AND role='customer' AND account_status='active')
    OR NEW.property_id IS NOT NULL
    OR (NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_order WHERE id=NEW.order_id AND customer_id=NEW.customer_id))
    OR (NEW.privacy_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_privacy_request WHERE id=NEW.privacy_request_id AND customer_id=NEW.customer_id))
   THEN RAISE EXCEPTION 'Invalid support customer scope' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT * INTO STRICT participant FROM support_request WHERE id=NEW.request_id;
  IF NEW.actor_kind='admin' THEN
   IF NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active=true AND (permissions IS NULL OR (CASE WHEN NEW.internal THEN permissions ?| array['admin.support.read','admin.support.write'] ELSE permissions @> '["admin.support.write"]'::jsonb END))) THEN RAISE EXCEPTION 'Invalid support administrator' USING ERRCODE='23514'; END IF;
  ELSE
   IF NEW.internal OR NEW.state_after NOT IN ('open','resolved')
    OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.actor_id AND (account_status='active' OR (account_status='pending_application' AND NEW.actor_kind='owner' AND role='client')) AND ((NEW.actor_kind='owner' AND role='client' AND id=participant.client_id) OR (NEW.actor_kind='customer' AND role='customer' AND id=participant.customer_id)))
   THEN RAISE EXCEPTION 'Invalid support participant' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
