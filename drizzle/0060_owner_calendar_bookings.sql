ALTER TABLE booking_order ADD COLUMN owner_note text NOT NULL DEFAULT '' CHECK(length(owner_note)<=500);
ALTER TABLE rentable ADD COLUMN arrival_guide jsonb NOT NULL DEFAULT '{}';
ALTER TABLE inventory_reservation ADD COLUMN kind text NOT NULL DEFAULT 'block' CHECK(kind IN ('block','offline_booking'));
ALTER TABLE inventory_reservation ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE TABLE calendar_feed(rentable_id uuid PRIMARY KEY REFERENCES rentable(id) ON DELETE CASCADE,token_hash text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz);
ALTER TABLE visit_evidence DROP CONSTRAINT visit_evidence_valid_chk;
ALTER TABLE visit_evidence ADD CONSTRAINT visit_evidence_valid_chk CHECK(kind IN ('handover','return','complete') AND nature IN ('actual','simulation') AND actor_kind IN ('owner','admin','staff','system') AND length(trim(note)) BETWEEN 0 AND 1000 AND request_hash ~ '^[a-f0-9]{64}$' AND occurred_at<=recorded_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_visit_evidence_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v booking; owner_id uuid; prior_time timestamptz; expected_state text;
BEGIN
  SELECT * INTO STRICT v FROM booking WHERE id=NEW.booking_id;
  SELECT client_id INTO owner_id FROM rentable WHERE id=v.rentable_id;
  IF NOT v.hours_known OR v.order_id IS NULL OR NEW.occurred_at<v.starts_at-(CASE WHEN NEW.kind='handover' THEN make_interval(mins=>coalesce((SELECT (booking_config->>'earlyArrivalMinutes')::int FROM rentable WHERE id=v.rentable_id),120)) ELSE interval '0' END) OR NEW.occurred_at>clock_timestamp()
    OR NEW.nature IS DISTINCT FROM (CASE WHEN v.visit_provenance='real' THEN 'actual' ELSE 'simulation' END) THEN
    RAISE EXCEPTION 'Invalid visit evidence scope' USING ERRCODE='23514';
  END IF;
  IF NEW.actor_kind='owner' THEN
    IF NEW.actor_id<>owner_id OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.actor_id AND role='client' AND account_status='active') THEN
      RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.actor_kind='system' THEN
    IF NEW.kind<>'complete' OR v.state<>'returned' OR NOT EXISTS(SELECT 1 FROM visit_evidence WHERE booking_id=v.id AND kind='return' AND recorded_at<=clock_timestamp()-interval '24 hours') OR EXISTS(SELECT 1 FROM visit_incident WHERE booking_id=v.id AND state='open') OR EXISTS(SELECT 1 FROM booking_case_visit cv JOIN booking_case c ON c.id=cv.case_id WHERE cv.booking_id=v.id AND c.state='open') THEN RAISE EXCEPTION 'Automatic completion needs settled return evidence' USING ERRCODE='23514'; END IF;
  ELSIF NEW.actor_kind='staff' THEN
    IF NOT EXISTS(SELECT 1 FROM client_staff s JOIN staff_property sp ON sp.staff_id=s.id AND sp.rentable_id=v.rentable_id
        JOIN "user" o ON o.id=s.client_id
        WHERE s.id=NEW.actor_id AND s.client_id=owner_id AND s.is_active AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
          AND s.permissions->>'evidence'='true' AND o.role='client' AND o.account_status='active') THEN
      RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active) THEN
    RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
  END IF;
  expected_state=CASE NEW.kind WHEN 'handover' THEN 'confirmed' WHEN 'return' THEN 'handed_over' WHEN 'complete' THEN 'returned' END;
  IF v.state::text IS DISTINCT FROM expected_state THEN RAISE EXCEPTION 'Invalid evidence transition' USING ERRCODE='23514'; END IF;
  IF NEW.kind<>'handover' THEN
    SELECT occurred_at INTO prior_time FROM visit_evidence WHERE booking_id=v.id AND kind=CASE NEW.kind WHEN 'return' THEN 'handover' ELSE 'return' END;
    IF prior_time IS NULL OR NEW.occurred_at<prior_time THEN RAISE EXCEPTION 'Prior evidence required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
ALTER TYPE booking_state ADD VALUE IF NOT EXISTS 'no_show';

ALTER TABLE booking_case DROP CONSTRAINT booking_case_valid_chk;
ALTER TABLE booking_case ADD CONSTRAINT booking_case_valid_chk CHECK ("booking_case"."type" IN ('owner_cancellation','customer_cancellation','change_request','no_show','late_arrival','operational')
    AND "booking_case"."requester_kind" IN ('customer','owner','admin') AND "booking_case"."source" IN ('portal','support','phone','email','internal')
    AND "booking_case"."created_by_kind" IN ('owner','admin') AND ("booking_case"."created_by_kind"='admin' OR ("booking_case"."requester_kind"='owner' AND "booking_case"."source"='portal'
      AND "booking_case"."type" IN ('owner_cancellation','no_show','late_arrival','operational')))
    AND length(trim("booking_case"."reason")) BETWEEN 10 AND 1000 AND ("booking_case"."requested_outcome" IS NULL OR length("booking_case"."requested_outcome") <= 500)
    AND "booking_case"."request_hash" ~ '^[a-f0-9]{64}$' AND "booking_case"."version" >= 1 AND "booking_case"."state" IN ('open','resolved')
    AND (("booking_case"."state"='open' AND "booking_case"."outcome" IS NULL AND "booking_case"."outcome_note" IS NULL AND "booking_case"."refund_basis" IS NULL AND "booking_case"."cancellation_id" IS NULL
        AND "booking_case"."resolved_at" IS NULL AND "booking_case"."resolved_by" IS NULL AND "booking_case"."resolve_key" IS NULL AND "booking_case"."resolve_hash" IS NULL)
      OR ("booking_case"."state"='resolved' AND "booking_case"."outcome" IN ('visits_cancelled','declined','no_change','no_show','partial_refund') AND length(trim("booking_case"."outcome_note")) BETWEEN 10 AND 1000
        AND "booking_case"."resolved_at" IS NOT NULL AND "booking_case"."resolved_by" IS NOT NULL AND "booking_case"."resolve_key" IS NOT NULL AND "booking_case"."resolve_hash" ~ '^[a-f0-9]{64}$'
        AND (("booking_case"."outcome"='visits_cancelled') = ("booking_case"."cancellation_id" IS NOT NULL))
        AND (("booking_case"."outcome"='visits_cancelled') = ("booking_case"."refund_basis" IN ('policy','full'))))));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_visit_transition_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phase text;
BEGIN
  IF OLD.state::text='no_show' AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'No-show is terminal' USING ERRCODE='23514'; END IF;
  IF NEW.state::text='no_show' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state::text<>'confirmed' OR OLD.starts_at>clock_timestamp() OR NOT OLD.hours_known OR NOT EXISTS(SELECT 1 FROM booking_case_visit cv JOIN booking_case c ON c.id=cv.case_id JOIN admin_user a ON a.id=c.resolved_by WHERE cv.booking_id=NEW.id AND c.type='no_show' AND c.outcome='no_show' AND c.state='resolved' AND a.is_active) THEN RAISE EXCEPTION 'No-show needs an overdue arrival and an admin resolution' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.order_id IS NOT NULL THEN
    phase=CASE NEW.state WHEN 'handed_over' THEN 'handover' WHEN 'returned' THEN 'return' WHEN 'completed' THEN 'complete' ELSE NULL END;
    IF phase IS NOT NULL AND (OLD.state::text IS DISTINCT FROM (CASE phase WHEN 'handover' THEN 'confirmed' WHEN 'return' THEN 'handed_over' ELSE 'returned' END)
      OR NOT EXISTS(SELECT 1 FROM visit_evidence WHERE booking_id=NEW.id AND kind=phase)) THEN
      RAISE EXCEPTION 'Visit transition requires recorded evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_visit_operator_valid(v booking, kind text, actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE kind
    WHEN 'owner' THEN EXISTS(SELECT 1 FROM rentable r JOIN "user" u ON u.id=r.client_id
      WHERE r.id=v.rentable_id AND u.id=actor AND u.role='client' AND u.account_status='active')
    WHEN 'admin' THEN EXISTS(SELECT 1 FROM admin_user WHERE id=actor AND is_active)
    ELSE false END
OR (kind='staff' AND EXISTS(SELECT 1 FROM client_staff s JOIN staff_property sp ON sp.staff_id=s.id AND sp.rentable_id=v.rentable_id JOIN rentable r ON r.id=sp.rentable_id JOIN "user" u ON u.id=r.client_id WHERE s.id=actor AND s.client_id=r.client_id AND s.is_active AND s.accepted_at IS NOT NULL AND s.revoked_at IS NULL AND s.permissions->>'evidence'='true' AND u.account_status='active'))
$$;
ALTER TABLE visit_incident DROP CONSTRAINT visit_incident_valid_chk;
ALTER TABLE visit_incident ADD CONSTRAINT visit_incident_valid_chk CHECK ("visit_incident"."category" IN ('damage','safety','access','conduct','amenity','other')
    AND "visit_incident"."nature" IN ('actual','simulation') AND "visit_incident"."actor_kind" IN ('owner','admin','staff') AND "visit_incident"."state" IN ('open','closed')
    AND length(trim("visit_incident"."summary")) BETWEEN 5 AND 120 AND length(trim("visit_incident"."description")) BETWEEN 20 AND 2000
    AND "visit_incident"."request_hash" ~ '^[a-f0-9]{64}$' AND "visit_incident"."occurred_at" <= "visit_incident"."created_at" AND "visit_incident"."version" >= 1
    AND (("visit_incident"."state"='open' AND "visit_incident"."closed_at" IS NULL AND "visit_incident"."closed_by" IS NULL AND "visit_incident"."resolution_note" IS NULL)
      OR ("visit_incident"."state"='closed' AND "visit_incident"."closed_at" IS NOT NULL AND "visit_incident"."closed_by" IS NOT NULL AND length(trim("visit_incident"."resolution_note")) BETWEEN 10 AND 1000)));
