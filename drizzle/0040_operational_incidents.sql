CREATE TABLE operational_incident (
  code varchar(48) PRIMARY KEY,
  status varchar(16) NOT NULL DEFAULT 'open',
  assignee_id uuid REFERENCES admin_user(id) ON DELETE RESTRICT,
  snoozed_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_incident_status_chk CHECK (status IN ('open','acknowledged','escalated','resolved') AND version > 0)
);--> statement-breakpoint
CREATE TABLE operational_incident_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(48) NOT NULL REFERENCES operational_incident(code) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  payload_hash varchar(64) NOT NULL,
  action varchar(16) NOT NULL,
  note text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal_count integer NOT NULL,
  sampled_at timestamptz NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_incident_event_chk CHECK (action IN ('open','reopen','assign','note','acknowledge','snooze','escalate','resolve') AND char_length(note) BETWEEN 8 AND 2000 AND signal_count >= 0 AND payload_hash ~ '^[a-f0-9]{64}$' AND jsonb_typeof(details)='object')
);--> statement-breakpoint
CREATE INDEX operational_incident_event_code_idx ON operational_incident_event(code,at);
--> statement-breakpoint
CREATE UNIQUE INDEX operational_incident_event_request_key_idx ON operational_incident_event(request_key);
--> statement-breakpoint
CREATE TRIGGER operational_incident_event_append_only BEFORE UPDATE OR DELETE ON operational_incident_event
FOR EACH ROW EXECUTE FUNCTION reject_audit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER operational_incident_event_no_truncate BEFORE TRUNCATE ON operational_incident_event
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_history_mutation();
