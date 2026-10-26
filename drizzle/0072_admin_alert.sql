-- Stories 1.6/1.7: durable reviewer alerts (owner resubmitted; correction unanswered at day 7/15/30).
-- One row per reviewer and event; the email intent and its delivery state live on the same row,
-- so an email failure never removes the portal alert.
CREATE TABLE admin_alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('property_resubmitted','correction_unanswered')),
  rentable_id uuid NOT NULL REFERENCES rentable(id),
  submission_id uuid REFERENCES listing_submission(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  email_state text NOT NULL DEFAULT 'pending'
    CHECK (email_state IN ('pending','retry','sending','sent','blocked','failed')),
  email_attempts integer NOT NULL DEFAULT 0,
  email_failure text,
  email_provider_id text,
  email_next_at timestamptz NOT NULL DEFAULT now(),
  email_sent_at timestamptz,
  UNIQUE (admin_id, event_key)
);--> statement-breakpoint
CREATE INDEX admin_alert_email_idx ON admin_alert(email_state, email_next_at)
  WHERE email_state IN ('pending','retry','sending');--> statement-breakpoint
CREATE INDEX admin_alert_inbox_idx ON admin_alert(admin_id, created_at DESC);
