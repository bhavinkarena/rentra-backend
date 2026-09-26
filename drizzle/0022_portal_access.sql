CREATE TABLE "portal_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "portal_session_principal_chk" CHECK (("portal_session"."user_id" IS NOT NULL) <> ("portal_session"."admin_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_user" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_admin_id_admin_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_session_user_idx" ON "portal_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "portal_session_admin_idx" ON "portal_session" USING btree ("admin_id");
--> statement-breakpoint
CREATE FUNCTION revoke_changed_portal_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  IF TG_TABLE_NAME='user' THEN
    IF OLD.role IS DISTINCT FROM NEW.role OR OLD.account_status IS DISTINCT FROM NEW.account_status
       OR OLD.email IS DISTINCT FROM NEW.email THEN
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
CREATE TRIGGER user_portal_access_revoked AFTER UPDATE ON "user"
FOR EACH ROW EXECUTE FUNCTION revoke_changed_portal_access();
--> statement-breakpoint
CREATE TRIGGER admin_portal_access_revoked AFTER UPDATE ON admin_user
FOR EACH ROW EXECUTE FUNCTION revoke_changed_portal_access();
