-- Manual rollback for migrations 0052-0054 (entertainment plan, Phase 3). NOT a drizzle migration.
-- Use only before any time-booked data exists; afterwards roll forward instead.
-- Run in one transaction:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f docs/rollback/0052-0054_entertainment.down.sql
-- Enum values added by 0053 ('hour', 'hourly', three document types) cannot be removed; unused values are harmless.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rentable WHERE rental_unit::text = 'hour')
     OR EXISTS (SELECT 1 FROM booking WHERE resource_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM inventory_reservation WHERE resource_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM document WHERE doc_type::text IN ('rent_agreement','shop_establishment','gst_certificate')) THEN
    RAISE EXCEPTION 'Time-booked data exists; roll forward instead of back.';
  END IF;
END $$;

-- 0054: restore the 24-hour reminder for every visit (body as installed by 0017).
CREATE OR REPLACE FUNCTION rentra_notification_event() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE customer uuid; template_name text; proof visit_evidence;
BEGIN
  SELECT customer_id INTO STRICT customer FROM booking_order WHERE id=NEW.order_id;
  template_name=CASE WHEN NEW.kind='confirmed' THEN 'confirmation' WHEN NEW.kind LIKE 'cancel_%' THEN 'cancellation'
    WHEN NEW.kind LIKE 'refund_%' THEN 'refund' ELSE NULL END;
  IF template_name IS NOT NULL THEN
    INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at)
      VALUES(NEW.order_id,customer,'event:'||NEW.id,template_name,clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.kind='confirmed' THEN
    INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
      SELECT NEW.order_id,b.id,customer,'reminder:'||b.id,'reminder',greatest(clock_timestamp(),b.starts_at-interval '24 hours')
      FROM booking b WHERE b.order_id=NEW.order_id AND b.state='confirmed' AND b.starts_at>clock_timestamp() ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.kind LIKE 'cancel_%' THEN
    UPDATE notification_outbox n SET state='suppressed',failure_code='VISIT_CANCELLED'
      WHERE n.order_id=NEW.order_id AND n.template IN ('reminder','review_invitation') AND n.state IN ('pending','blocked','retry','failed')
      AND EXISTS(SELECT 1 FROM booking b WHERE b.id=n.booking_id AND b.state='cancelled');
  END IF;
  IF NEW.kind LIKE 'visit_%' AND NEW.payload->>'phase'='complete' THEN
    SELECT * INTO proof FROM visit_evidence WHERE id=(NEW.payload->>'evidenceId')::uuid AND kind='complete'
      AND booking_id IN (SELECT id FROM booking WHERE order_id=NEW.order_id);
    IF proof.id IS NOT NULL THEN
      INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
        VALUES(NEW.order_id,proof.booking_id,customer,'complete:'||proof.booking_id,'completion',clock_timestamp()) ON CONFLICT DO NOTHING;
      IF proof.nature='actual' THEN
        INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
          VALUES(NEW.order_id,proof.booking_id,customer,'review:'||proof.booking_id,'review_invitation',clock_timestamp()) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 0053: per-listing lock, guards and tables.
ALTER TABLE inventory_reservation DROP CONSTRAINT reservation_active_overlap_excl;
ALTER TABLE inventory_reservation ADD CONSTRAINT reservation_active_overlap_excl
  EXCLUDE USING gist ("rentable_id" WITH =, tstzrange("blocked_start_at", "blocked_end_at", '[)') WITH &&)
  WHERE ("state" IN ('held', 'committed'));
ALTER TABLE inventory_reservation DROP COLUMN resource_id;
ALTER TABLE booking DROP CONSTRAINT booking_resource_slot_chk;
ALTER TABLE booking DROP COLUMN resource_id;
DROP TABLE rentable_rate;
DROP TABLE rentable_resource_activity;
DROP TABLE rentable_resource;
DROP FUNCTION resource_activity_guard();
CREATE OR REPLACE FUNCTION catalogue_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_TABLE_NAME = 'rentable' THEN
  IF TG_OP = 'INSERT' OR NEW.city_id IS DISTINCT FROM OLD.city_id OR NEW.area_id IS DISTINCT FROM OLD.area_id OR NEW.category_id IS DISTINCT FROM OLD.category_id THEN
   PERFORM 1 FROM city WHERE id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM area WHERE id=NEW.area_id AND city_id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active area in this city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM category WHERE id=NEW.category_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active category' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF TG_OP = 'INSERT' OR NEW.amenity_id IS DISTINCT FROM OLD.amenity_id THEN
   PERFORM 1 FROM amenity WHERE id=NEW.amenity_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active amenity' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;

-- 0052: entertainment categories go with it (they cannot exist without the vertical).
DELETE FROM category WHERE vertical_code <> 'farmhouse';
DROP TABLE amenity_vertical;
ALTER TABLE category DROP COLUMN icon_key;
ALTER TABLE category DROP COLUMN vertical_code;
DROP TABLE vertical;

-- Forget the three migrations so a later db:migrate can apply them again.
DO $$ BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= 1790591200000;
  END IF;
END $$;
