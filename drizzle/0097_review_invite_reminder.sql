-- Story 5.3: review invitations wait for checkout + 3 hours; one day-7 review reminder template.
ALTER TABLE notification_outbox DROP CONSTRAINT notification_valid_chk;--> statement-breakpoint
ALTER TABLE notification_outbox ADD CONSTRAINT notification_valid_chk CHECK ("notification_outbox"."template" IN ('confirmation','reminder','cancellation','refund','completion','review_invitation','arrival_guide','request_approved','request_declined','review_reminder')
    AND "notification_outbox"."channel"='sms' AND "notification_outbox"."attempts">=0 AND "notification_outbox"."state" IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed'));--> statement-breakpoint

-- Review invitations respect quiet hours: at ts if 09:00-20:59 IST, else the next 09:00 IST; never before now.
CREATE OR REPLACE FUNCTION rentra_review_invite_at(ts timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN extract(hour FROM l) BETWEEN 9 AND 20 THEN t
    ELSE ((l::date + (extract(hour FROM l) >= 21)::int)::timestamp + time '09:00') AT TIME ZONE 'Asia/Kolkata' END
  FROM (SELECT greatest(ts,clock_timestamp()) t) a, LATERAL (SELECT a.t AT TIME ZONE 'Asia/Kolkata' l) b
$$;--> statement-breakpoint
-- The review window end: an approved exception's window, else booked checkout + 30 days.
CREATE OR REPLACE FUNCTION rentra_review_window_end(visit uuid, author uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT x.window_ends_at FROM review_eligibility_exception x WHERE x.booking_id=visit AND x.author_id=author
    AND x.decision='approved' AND x.revoked_at IS NULL), (SELECT b.ends_at+interval '30 days' FROM booking b WHERE b.id=visit))
$$;--> statement-breakpoint
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
      WHERE n.order_id=NEW.order_id AND n.template IN ('reminder','review_invitation','review_reminder') AND n.state IN ('pending','blocked','retry','failed')
      AND EXISTS(SELECT 1 FROM booking b WHERE b.id=n.booking_id AND b.state='cancelled')
      -- Arrival-exception review rows exist for cancelled visits by design; keep them.
      AND NOT (n.template IN ('review_invitation','review_reminder') AND EXISTS(SELECT 1 FROM review_eligibility_exception x
        WHERE x.booking_id=n.booking_id AND x.author_id=n.customer_id AND x.decision='approved' AND x.revoked_at IS NULL));
  END IF;
  IF NEW.kind LIKE 'visit_%' AND NEW.payload->>'phase'='complete' THEN
    SELECT * INTO proof FROM visit_evidence WHERE id=(NEW.payload->>'evidenceId')::uuid AND kind='complete'
      AND booking_id IN (SELECT id FROM booking WHERE order_id=NEW.order_id);
    IF proof.id IS NOT NULL THEN
      INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
        VALUES(NEW.order_id,proof.booking_id,customer,'complete:'||proof.booking_id,'completion',clock_timestamp()) ON CONFLICT DO NOTHING;
      IF proof.nature='actual' THEN
        INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
          SELECT NEW.order_id,proof.booking_id,customer,'review:'||proof.booking_id,'review_invitation',
            rentra_review_invite_at(coalesce(b.ends_at+interval '3 hours',clock_timestamp())) FROM booking b WHERE b.id=proof.booking_id
          ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
