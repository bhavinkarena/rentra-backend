-- Entertainment plan, Phase 3: hourly bookings get a reminder 2 hours before start (farmhouse stays at 24 hours),
-- and none when it would fire within 15 minutes of confirmation. Body otherwise identical to the function
-- installed by 0017 (taken from pg_get_functiondef at the 0051 head). Text comparison only (55P04).
CREATE OR REPLACE FUNCTION rentra_notification_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
