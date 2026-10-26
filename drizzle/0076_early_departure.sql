-- Original accepted dates and nightly prices remain intact; only unused stock ends early.
ALTER TABLE booking_room ADD COLUMN departed_at timestamptz;
--> statement-breakpoint
ALTER TABLE booking_room ADD COLUMN inventory_end date;
--> statement-breakpoint
ALTER TABLE booking_room ADD CONSTRAINT booking_room_departure_chk CHECK (
  (departed_at IS NULL AND inventory_end IS NULL) OR
  (departed_at IS NOT NULL AND inventory_end IS NOT NULL AND state='stayed'
    AND inventory_end > check_in AND inventory_end <= check_out)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION booking_room_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line booking_room; was text; now_kind text; old_end date; new_end date;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.room_type_id, NEW.check_in, NEW.check_out, NEW.booking_id)
      IS DISTINCT FROM (OLD.room_type_id, OLD.check_in, OLD.check_out, OLD.booking_id) THEN
    RAISE EXCEPTION 'A booked room cannot move; release it and book again' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.departed_at IS NOT NULL AND
    (NEW.departed_at,NEW.inventory_end) IS DISTINCT FROM (OLD.departed_at,OLD.inventory_end) THEN
    RAISE EXCEPTION 'A recorded departure is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.departed_at IS NULL AND NEW.departed_at IS NOT NULL AND OLD.state <> 'booked' THEN
    RAISE EXCEPTION 'Only a booked room can depart' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
  was := CASE WHEN TG_OP = 'INSERT' OR OLD.state = 'released' THEN NULL WHEN OLD.state = 'held' THEN 'held' ELSE 'sold' END;
  now_kind := CASE WHEN TG_OP = 'DELETE' OR NEW.state = 'released' THEN NULL WHEN NEW.state = 'held' THEN 'held' ELSE 'sold' END;
  old_end := CASE WHEN TG_OP <> 'INSERT' THEN coalesce(OLD.inventory_end,OLD.check_out) END;
  new_end := CASE WHEN TG_OP <> 'DELETE' THEN coalesce(NEW.inventory_end,NEW.check_out) END;
  IF TG_OP = 'UPDATE' AND OLD.state = 'released' AND NEW.state <> 'released' THEN
    RAISE EXCEPTION 'A released room cannot be booked again' USING ERRCODE = '23514';
  END IF;
  IF was IS NOT DISTINCT FROM now_kind AND old_end IS NOT DISTINCT FROM new_end THEN RETURN NULL; END IF;
  IF now_kind IS NOT NULL THEN
    INSERT INTO room_night (room_type_id, night, allotment)
    SELECT line.room_type_id, d::date, rt.room_count
    FROM room_type rt, generate_series(line.check_in, new_end - 1, interval '1 day') d
    WHERE rt.id = line.room_type_id ON CONFLICT DO NOTHING;
  END IF;
  UPDATE room_night rn SET
    held = rn.held + ((now_kind IS NOT DISTINCT FROM 'held') AND rn.night < new_end)::int
      - ((was IS NOT DISTINCT FROM 'held') AND rn.night < old_end)::int,
    sold = rn.sold + ((now_kind IS NOT DISTINCT FROM 'sold') AND rn.night < new_end)::int
      - ((was IS NOT DISTINCT FROM 'sold') AND rn.night < old_end)::int,
    updated_at = now()
  FROM (SELECT room_type_id, night FROM room_night WHERE room_type_id = line.room_type_id
    AND night >= line.check_in AND night < line.check_out ORDER BY night FOR UPDATE) k
  WHERE rn.room_type_id = k.room_type_id AND rn.night = k.night;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM room_night WHERE room_type_id = line.room_type_id
      AND night >= line.check_in AND night < new_end AND stop_sell;
    IF FOUND THEN RAISE EXCEPTION 'This room type is closed on one of these nights' USING ERRCODE = '23514', CONSTRAINT = 'room_night_stop_sell'; END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_update_from_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; v record; departure boolean;
BEGIN
  departure := NEW.kind ~ '^depart_[a-f0-9]{32}$';
  IF NEW.kind <> 'confirmed' AND NEW.kind !~ '^cancel_[a-f0-9]{32}$' AND NOT departure THEN RETURN NEW; END IF;
  SELECT bo.id, bo.reference, bo.rentable_id, bo.visit_provenance, r.client_id,
    EXISTS (SELECT 1 FROM payment_order p WHERE p.booking_order_id = bo.id AND p.environment = 'test') AS test_payment
    INTO o FROM booking_order bo JOIN rentable r ON r.id = bo.rentable_id WHERE bo.id = NEW.order_id;
  IF o.client_id IS NULL THEN RETURN NEW; END IF;
  SELECT local_day::text AS visit_date,slot_snapshot->>'checkOut' AS check_out INTO v FROM booking
    WHERE order_id=o.id ORDER BY id LIMIT 1;
  PERFORM client_update_insert(o.client_id, 'lifecycle:' || NEW.id, 'booking', 'info',
    CASE WHEN departure THEN 'rooms_departed_early' WHEN NEW.kind = 'confirmed' THEN 'booking_confirmed' ELSE 'visits_cancelled' END,
    o.rentable_id, o.id,
    jsonb_build_object('reference', o.reference, 'simulation', (o.visit_provenance IS DISTINCT FROM 'real') OR o.test_payment)
      || CASE WHEN departure THEN jsonb_build_object('slot','stay','visitDate',v.visit_date,'checkOut',v.check_out,
        'rooms',NEW.payload->'rooms','roomIds',NEW.payload->'roomIds','departedAt',NEW.payload->'departedAt','roomDetails',NEW.payload->'roomDetails') ELSE '{}'::jsonb END,
    NEW.created_at);
  RETURN NEW;
END $$;

--> statement-breakpoint
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
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.order_id IS NOT NULL THEN
    phase=CASE NEW.state WHEN 'handed_over' THEN 'handover' WHEN 'returned' THEN 'return' WHEN 'completed' THEN 'complete' ELSE NULL END;
    IF phase IS NOT NULL AND (OLD.state::text IS DISTINCT FROM (CASE phase WHEN 'handover' THEN 'confirmed' WHEN 'return' THEN 'handed_over' ELSE 'returned' END)
      OR NOT EXISTS(SELECT 1 FROM visit_evidence WHERE booking_id=NEW.id AND kind=phase)) THEN
      RAISE EXCEPTION 'Visit transition requires recorded evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
