ALTER TABLE auth_session ADD COLUMN reauthenticated_at timestamptz;
--> statement-breakpoint
ALTER TABLE otp_challenge DROP CONSTRAINT otp_challenge_valid_chk;
--> statement-breakpoint
ALTER TABLE otp_challenge ADD CONSTRAINT otp_challenge_valid_chk CHECK (
 principal_kind IN ('customer','client','staff') AND channel IN ('sms','email')
 AND purpose IN ('login','verify_phone','phone_change','payout_confirm') AND attempts>=0
 AND code_hash ~ '^[a-f0-9]{64}$' AND expires_at>created_at
 AND (browser_hash IS NULL OR browser_hash ~ '^[a-f0-9]{64}$')
 AND (purpose<>'phone_change' OR (principal_kind='customer' AND user_id IS NOT NULL AND session_id IS NOT NULL))
 AND (purpose<>'payout_confirm' OR (principal_kind='client' AND user_id IS NOT NULL AND session_id IS NOT NULL))
);
