-- Phase 9 of docs/DATABASE-REVIEW.md: one challenge table for every principal; hashed rate events.
-- Codes live at most 10 minutes, so no rows are copied: a code in flight at deploy is re-requested.

CREATE TABLE otp_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_kind varchar(10) NOT NULL,
  channel varchar(8) NOT NULL,
  purpose varchar(16) NOT NULL,
  identifier varchar(254) NOT NULL,
  code_hash varchar(64) NOT NULL,
  browser_hash varchar(64),
  delivery_mode varchar(16) NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  user_id uuid REFERENCES "user"(id) ON DELETE CASCADE,
  session_id uuid REFERENCES auth_session(id) ON DELETE CASCADE,
  original_phone varchar(15),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenge_valid_chk CHECK (
    principal_kind IN ('customer', 'client', 'staff') AND channel IN ('sms', 'email')
    AND purpose IN ('login', 'verify_phone', 'phone_change') AND attempts >= 0
    AND code_hash ~ '^[a-f0-9]{64}$' AND expires_at > created_at
    AND (browser_hash IS NULL OR browser_hash ~ '^[a-f0-9]{64}$')
    AND (purpose <> 'phone_change' OR (principal_kind = 'customer' AND user_id IS NOT NULL AND session_id IS NOT NULL)))
);--> statement-breakpoint
CREATE INDEX otp_challenge_lookup_idx ON otp_challenge (principal_kind, identifier, purpose, created_at);--> statement-breakpoint
CREATE INDEX otp_challenge_user_idx ON otp_challenge (user_id) WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX otp_challenge_session_idx ON otp_challenge (session_id) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX otp_challenge_purge_idx ON otp_challenge (created_at);--> statement-breakpoint

DROP TABLE otp_token;--> statement-breakpoint
DROP TABLE customer_otp_challenge;--> statement-breakpoint
DROP TYPE otp_channel;--> statement-breakpoint
DROP TYPE otp_purpose;--> statement-breakpoint

-- Rate events: HMAC identifiers only, never a phone number or IP in clear.
ALTER TABLE customer_auth_rate RENAME TO auth_rate_event;--> statement-breakpoint
ALTER TABLE auth_rate_event RENAME COLUMN phone_hash TO identifier_hash;--> statement-breakpoint
ALTER TABLE auth_rate_event ADD COLUMN principal_kind varchar(10) NOT NULL DEFAULT 'customer';--> statement-breakpoint
ALTER INDEX customer_auth_rate_pkey RENAME TO auth_rate_event_pkey;--> statement-breakpoint
ALTER INDEX customer_auth_phone_rate_idx RENAME TO auth_rate_identifier_idx;--> statement-breakpoint
ALTER INDEX customer_auth_ip_rate_idx RENAME TO auth_rate_ip_idx;--> statement-breakpoint
CREATE INDEX auth_rate_event_purge_idx ON auth_rate_event (created_at);--> statement-breakpoint
ALTER TABLE auth_rate_event ADD CONSTRAINT auth_rate_event_valid_chk CHECK (
  principal_kind IN ('customer', 'client', 'staff') AND kind IN ('request', 'verify')
  AND identifier_hash ~ '^[a-f0-9]{64}$' AND ip_hash ~ '^[a-f0-9]{64}$');
