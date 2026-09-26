ALTER TABLE "client_application" ADD COLUMN "review_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "client_application" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "client_application" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_application" ADD CONSTRAINT "client_application_assigned_to_admin_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_queue_idx" ON "client_application" USING btree ("status","assigned_to","submitted_at");
--> statement-breakpoint
-- Gate 1 approval (pending_application -> active) only widens access, and
-- capabilities are derived from the live status on every request, so it no
-- longer forces the newly approved client to sign in again. Every other
-- status change, role change or email change still revokes sessions.
CREATE OR REPLACE FUNCTION revoke_changed_portal_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  IF TG_TABLE_NAME='user' THEN
    IF OLD.role IS DISTINCT FROM NEW.role OR OLD.email IS DISTINCT FROM NEW.email
       OR (OLD.account_status IS DISTINCT FROM NEW.account_status
           AND NOT (OLD.account_status='pending_application' AND NEW.account_status='active')) THEN
      UPDATE portal_session SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected>0 THEN
        INSERT INTO audit_log(actor_type,entity,entity_id,action,after)
        VALUES ('system','user',NEW.id::text,'access_sessions_revoked',jsonb_build_object('count',affected));
      END IF;
    END IF;
  ELSE
    IF OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.permissions IS DISTINCT FROM NEW.permissions
       OR OLD.password_hash IS DISTINCT FROM NEW.password_hash OR OLD.totp_secret IS DISTINCT FROM NEW.totp_secret
       OR OLD.email IS DISTINCT FROM NEW.email THEN
      UPDATE portal_session SET revoked_at=now() WHERE admin_id=NEW.id AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected>0 THEN
        INSERT INTO audit_log(actor_type,entity,entity_id,action,after)
        VALUES ('system','admin_user',NEW.id::text,'access_sessions_revoked',jsonb_build_object('count',affected));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Defensive normalization: CP03/CP04 admin audit rows written with a
-- `<json string>::jsonb` parameter could be stored as a JSON string on some
-- driver paths (observed on local disposable databases). The code now casts
-- through text. Idempotent; a no-op where rows are already objects.
UPDATE audit_log SET "before" = ("before" #>> '{}')::jsonb
WHERE jsonb_typeof("before") = 'string' AND actor_type = 'admin'
  AND action IN ('client_suspended','client_reinstated','customer_restricted','customer_reinstated',
                 'customer_sessions_revoked','customer_profile_corrected');
--> statement-breakpoint
UPDATE audit_log SET "after" = ("after" #>> '{}')::jsonb
WHERE jsonb_typeof("after") = 'string' AND actor_type = 'admin'
  AND action IN ('client_suspended','client_reinstated','customer_restricted','customer_reinstated',
                 'customer_sessions_revoked','customer_profile_corrected');
