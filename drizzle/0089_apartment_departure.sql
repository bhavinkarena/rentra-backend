-- Story 3.11: an apartment stay left early completes like a hotel stay left early. 0076's proof requires
-- booking_room rows, which whole apartments do not have; this adds the apartment case and changes nothing else.
CREATE OR REPLACE FUNCTION rentra_visit_transition_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phase text;
BEGIN
  IF OLD.state::text='no_show' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'No-show is terminal' USING ERRCODE='23514'; END IF;
  IF NEW.state::text='no_show' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state::text<>'confirmed' OR OLD.starts_at>clock_timestamp() OR NOT OLD.hours_known OR NOT EXISTS(SELECT 1 FROM booking_case_visit cv JOIN booking_case c ON c.id=cv.case_id JOIN admin_user a ON a.id=c.resolved_by WHERE cv.booking_id=NEW.id AND c.type='no_show' AND c.outcome='no_show' AND c.state='resolved' AND a.is_active) THEN RAISE EXCEPTION 'No-show needs an overdue arrival and an admin resolution' USING ERRCODE='23514'; END IF;
  END IF;
  -- Explicit guest departure is occupancy proof, never invented visit evidence.
  IF NEW.state::text='completed' AND OLD.state::text IN ('confirmed','handed_over','returned')
    AND OLD.slot::text='stay' AND OLD.hours_known AND OLD.starts_at<=clock_timestamp() AND OLD.ends_at>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM booking_room br WHERE br.booking_id=NEW.id AND br.state IN ('booked','held'))
    AND EXISTS(SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
      WHERE c.order_id=NEW.order_id AND c.customer_id=NEW.customer_id AND c.snapshot->>'operation'='early_departure'
        AND v->>'id'=NEW.id::text AND EXISTS(SELECT 1 FROM booking_room br WHERE br.booking_id=NEW.id
          AND br.departed_at=(c.snapshot->>'departedAt')::timestamptz AND v->'roomIds' ? br.id::text)) THEN RETURN NEW; END IF;
  -- Story 3.11: a whole apartment the guest left early (no booking_room rows; the departure receipt names the visit).
  IF NEW.state::text='completed' AND OLD.state::text IN ('confirmed','handed_over','returned')
    AND OLD.slot::text='stay' AND OLD.slot_snapshot ? 'apartment' AND OLD.hours_known AND OLD.starts_at<=clock_timestamp()
    AND EXISTS(SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
      WHERE c.order_id=NEW.order_id AND c.customer_id=NEW.customer_id AND c.snapshot->>'operation'='early_departure'
        AND v->>'id'=NEW.id::text) THEN RETURN NEW; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.order_id IS NOT NULL THEN
    phase=CASE NEW.state WHEN 'handed_over' THEN 'handover' WHEN 'returned' THEN 'return' WHEN 'completed' THEN 'complete' ELSE NULL END;
    IF phase IS NOT NULL AND (OLD.state::text IS DISTINCT FROM (CASE phase WHEN 'handover' THEN 'confirmed' WHEN 'return' THEN 'handed_over' ELSE 'returned' END)
      OR NOT EXISTS(SELECT 1 FROM visit_evidence WHERE booking_id=NEW.id AND kind=phase)) THEN
      RAISE EXCEPTION 'Visit transition requires recorded evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

