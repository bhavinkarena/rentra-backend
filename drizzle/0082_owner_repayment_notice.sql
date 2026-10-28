-- Story 2.19: Test-only repayment notice receipt. One notice per owner_recovery, issued with its first
-- repayment link. received_at = earliest evidence (owner portal view, owner ack, admin confirmation).
-- A link being created, replaced or closed is never receipt. No SMS/email; nothing blocks bookings here.
CREATE TABLE owner_repayment_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_id uuid NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  received_via text CHECK (received_via IN ('portal_view','owner_ack','admin_confirmed')),
  reminder_at timestamptz,
  due_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recovery_id,owner_id) REFERENCES owner_recovery(id,owner_id) ON DELETE RESTRICT,
  CHECK ((received_at IS NULL AND received_via IS NULL AND reminder_at IS NULL AND due_at IS NULL)
    OR (received_at IS NOT NULL AND received_via IS NOT NULL
      AND reminder_at=received_at+interval '5 days' AND due_at=received_at+interval '7 days'))
);
--> statement-breakpoint
CREATE INDEX owner_repayment_notice_owner ON owner_repayment_notice(owner_id);
--> statement-breakpoint
CREATE TABLE owner_repayment_notice_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES owner_repayment_notice(id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('portal_view','owner_ack','admin_confirmed')),
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner','admin')),
  actor_id uuid NOT NULL,
  evidence jsonb NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(notice_id,actor_kind,actor_id,request_key)
);
--> statement-breakpoint
CREATE INDEX owner_repayment_notice_event_notice ON owner_repayment_notice_event(notice_id,occurred_at);
--> statement-breakpoint
CREATE FUNCTION rentra_owner_repayment_notice_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Repayment notice events are append-only' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER owner_repayment_notice_event_append_only BEFORE UPDATE OR DELETE ON owner_repayment_notice_event
  FOR EACH ROW EXECUTE FUNCTION rentra_owner_repayment_notice_event_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_repayment_notice_event_no_truncate BEFORE TRUNCATE ON owner_repayment_notice_event
  FOR EACH STATEMENT EXECUTE FUNCTION rentra_owner_repayment_notice_event_append_only();
