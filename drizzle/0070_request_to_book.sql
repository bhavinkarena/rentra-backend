-- Request to book: an owner may confirm each booking before the guest pays. Instant book stays the default.
ALTER TABLE rentable ADD COLUMN instant_book boolean NOT NULL DEFAULT true;--> statement-breakpoint

-- The owner's approval moves a request's hold deadline to the payment window. Only while the order is
-- still held and no payment has started; accepted terms and amounts stay immutable.
CREATE OR REPLACE FUNCTION rentra_checkout_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; pinned boolean; mutable text[];
BEGIN
  IF TG_TABLE_NAME='booking_order' THEN
    parent_id=OLD.id;
    mutable=ARRAY['state','confirmed_at','updated_at'];
    IF TG_OP='UPDATE' AND OLD.state='held' AND NEW.state='held' AND EXISTS(SELECT 1 FROM payment_order p
      JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=OLD.id AND e.state='ready') THEN
      mutable=mutable||ARRAY['hold_expires_at'];
    END IF;
  ELSE
    parent_id=OLD.order_id;
    mutable=ARRAY['state','confirmed_at','cancelled_at','cancelled_by_kind','cancellation_reason','updated_at','lifecycle_version'];
  END IF;
  SELECT EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=parent_id) INTO pinned;
  IF pinned AND (TG_OP='DELETE' OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)) THEN
    RAISE EXCEPTION 'Accepted checkout terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- The guest hears the owner's answer by SMS.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_valid_chk;--> statement-breakpoint
ALTER TABLE notification_outbox ADD CONSTRAINT notification_valid_chk CHECK ("notification_outbox"."template" IN ('confirmation','reminder','cancellation','refund','completion','review_invitation','arrival_guide','request_approved','request_declined')
    AND "notification_outbox"."channel"='sms' AND "notification_outbox"."attempts">=0 AND "notification_outbox"."state" IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed'));--> statement-breakpoint

CREATE OR REPLACE FUNCTION rentra_notification_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE customer uuid; template_name text; proof visit_evidence;
BEGIN
  SELECT customer_id INTO STRICT customer FROM booking_order WHERE id=NEW.order_id;
  template_name=CASE WHEN NEW.kind='confirmed' THEN 'confirmation' WHEN NEW.kind LIKE 'cancel_%' THEN 'cancellation'
    WHEN NEW.kind LIKE 'refund_%' THEN 'refund' WHEN NEW.kind='owner_approved' THEN 'request_approved'
    WHEN NEW.kind='owner_declined' THEN 'request_declined' ELSE NULL END;
  IF template_name IS NOT NULL THEN
    INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at)
      VALUES(NEW.order_id,customer,'event:'||NEW.id,template_name,clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.kind='confirmed' THEN
    INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
      SELECT NEW.order_id,b.id,customer,'reminder:'||b.id,'reminder',
             greatest(clock_timestamp(),b.starts_at-CASE WHEN b.slot::text='hourly' THEN interval '2 hours' ELSE interval '24 hours' END)
      FROM booking b WHERE b.order_id=NEW.order_id AND b.state='confirmed' AND b.starts_at>clock_timestamp()
        -- A same-day hourly booking already gets the confirmation SMS; skip a reminder that would fire with it.
        AND (b.slot::text <> 'hourly' OR b.starts_at-interval '2 hours' > clock_timestamp()+interval '15 minutes')
      ON CONFLICT DO NOTHING;
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
