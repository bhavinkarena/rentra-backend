-- Phase 3 of docs/DATABASE-REVIEW.md: role lookup, profile merge, one session table, role-checked FKs.

-- 1. Role lookup table replaces the user_role enum.
CREATE TABLE role (
  code varchar(16) PRIMARY KEY,
  label varchar(60) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_code_chk CHECK (code ~ '^[a-z_]{3,16}$')
);--> statement-breakpoint
INSERT INTO role (code, label, sort_order) VALUES
  ('customer', 'Customer', 1),
  ('client', 'Client (owner or authorised agent)', 2);--> statement-breakpoint

-- Objects that embed the enum type are dropped and recreated around the type change.
DROP VIEW public_customer_review;--> statement-breakpoint
DROP INDEX review_rentable_public_idx;--> statement-breakpoint
DROP TRIGGER customer_status_session_revocation ON "user";--> statement-breakpoint

ALTER TABLE "user" ALTER COLUMN role TYPE varchar(16) USING role::text;--> statement-breakpoint
ALTER TABLE review ALTER COLUMN author_role TYPE varchar(16) USING author_role::text;--> statement-breakpoint
-- Who cancelled is not always a user role: admin cases and system expiry wrote NULL.
ALTER TABLE booking RENAME COLUMN cancelled_by TO cancelled_by_kind;--> statement-breakpoint
ALTER TABLE booking ALTER COLUMN cancelled_by_kind TYPE varchar(16) USING cancelled_by_kind::text;--> statement-breakpoint
-- Historical NULLs stay NULL (unknown); new writers always record the kind.
ALTER TABLE booking ADD CONSTRAINT booking_cancelled_by_kind_chk
  CHECK (cancelled_by_kind IS NULL OR cancelled_by_kind IN ('customer', 'client', 'admin', 'system'));--> statement-breakpoint
DROP TYPE user_role;--> statement-breakpoint

ALTER TABLE "user" ADD CONSTRAINT user_role_fk FOREIGN KEY (role) REFERENCES role(code) ON UPDATE RESTRICT ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_author_role_fk FOREIGN KEY (author_role) REFERENCES role(code) ON UPDATE RESTRICT ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX review_rentable_public_idx ON review (rentable_id) WHERE author_role = 'customer' AND moderation_state = 'published';--> statement-breakpoint
CREATE VIEW public_customer_review AS
  SELECT r.* FROM review r
   WHERE r.author_role = 'customer' AND r.moderation_state = 'published' AND r.published_at IS NOT NULL
     AND rentra_review_eligible(r.booking_id, r.author_id, r.rentable_id);--> statement-breakpoint

-- The checkout-terms guard names mutable booking columns; follow the rename.
CREATE OR REPLACE FUNCTION rentra_checkout_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; pinned boolean; mutable text[];
BEGIN
  IF TG_TABLE_NAME='booking_order' THEN
    parent_id=OLD.id;
    mutable=ARRAY['state','confirmed_at','updated_at'];
  ELSE
    parent_id=OLD.order_id;
    mutable=ARRAY['state','confirmed_at','cancelled_at','cancelled_by_kind','cancellation_reason','updated_at','lifecycle_version','check_in_code','balance_settled_at'];
  END IF;
  SELECT EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=parent_id) INTO pinned;
  IF pinned AND (TG_OP='DELETE' OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)) THEN
    RAISE EXCEPTION 'Accepted checkout terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- 2. customer_profile and client_update_preference move onto "user".
ALTER TABLE "user"
  ADD COLUMN photo_public_id text,
  ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_updated_at timestamptz,
  ADD COLUMN profile_completed_at timestamptz,
  ADD COLUMN profile_version integer NOT NULL DEFAULT 0,
  ADD COLUMN muted_update_categories jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
UPDATE "user" u SET photo_public_id = p.photo_public_id, marketing_consent = p.marketing_consent,
    consent_updated_at = p.consent_updated_at, profile_completed_at = p.completed_at, profile_version = p.version
  FROM customer_profile p WHERE p.user_id = u.id;--> statement-breakpoint
UPDATE "user" u SET muted_update_categories = c.muted, profile_version = greatest(u.profile_version, c.version)
  FROM client_update_preference c WHERE c.user_id = u.id;--> statement-breakpoint

-- Role-specific fields: normalise values that never meant anything for the other role.
UPDATE "user" SET kyc_status = 'none', client_type = NULL, responds_within_mins = NULL, response_rate = NULL,
    muted_update_categories = '[]'::jsonb
  WHERE role = 'customer' AND (kyc_status <> 'none' OR client_type IS NOT NULL OR responds_within_mins IS NOT NULL
    OR response_rate IS NOT NULL OR muted_update_categories <> '[]'::jsonb);--> statement-breakpoint
UPDATE "user" SET privacy_erasure_pending = false
  WHERE role = 'client' AND privacy_erasure_pending AND privacy_erased_at IS NULL;--> statement-breakpoint
ALTER TABLE "user"
  ADD CONSTRAINT user_client_fields_chk CHECK (role = 'client' OR (client_type IS NULL AND kyc_status = 'none'
    AND muted_update_categories = '[]'::jsonb AND responds_within_mins IS NULL AND response_rate IS NULL)),
  ADD CONSTRAINT user_customer_fields_chk CHECK (role = 'customer' OR (privacy_erasure_pending = false AND privacy_erased_at IS NULL)),
  ADD CONSTRAINT user_muted_shape_chk CHECK (jsonb_typeof(muted_update_categories) = 'array'),
  ADD CONSTRAINT user_versions_chk CHECK (profile_version >= 0 AND lifecycle_version > 0);--> statement-breakpoint

CREATE OR REPLACE FUNCTION client_update_insert(p_client uuid, p_key text, p_category text, p_kind text, p_action text,
  p_rentable uuid, p_order uuid, p_detail jsonb, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO client_update(client_id, event_key, category, kind, action, rentable_id, order_id, detail, created_at, read_at)
  VALUES (p_client, p_key, p_category, p_kind, p_action, p_rentable, p_order, coalesce(p_detail, '{}'::jsonb), p_at,
    CASE WHEN p_kind = 'info' AND EXISTS (SELECT 1 FROM "user" pr
      WHERE pr.id = p_client AND pr.muted_update_categories ? p_category) THEN p_at END)
  ON CONFLICT (client_id, event_key) DO NOTHING;
END; $$;--> statement-breakpoint

DROP TABLE customer_profile;--> statement-breakpoint
DROP TABLE client_update_preference;--> statement-breakpoint

-- 3. One session table for every principal. Customer session ids are kept, so live cookies stay valid.
ALTER TABLE portal_session RENAME TO auth_session;--> statement-breakpoint
ALTER TABLE auth_session RENAME CONSTRAINT portal_session_principal_chk TO auth_session_principal_chk;--> statement-breakpoint
ALTER TABLE auth_session RENAME CONSTRAINT portal_session_user_id_user_id_fk TO auth_session_user_id_user_id_fk;--> statement-breakpoint
ALTER TABLE auth_session RENAME CONSTRAINT portal_session_admin_id_admin_user_id_fk TO auth_session_admin_id_admin_user_id_fk;--> statement-breakpoint
ALTER TABLE auth_session DROP CONSTRAINT portal_session_staff_id_client_staff_id_fk,
  ADD CONSTRAINT auth_session_staff_id_client_staff_id_fk FOREIGN KEY (staff_id) REFERENCES client_staff(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER INDEX portal_session_pkey RENAME TO auth_session_pkey;--> statement-breakpoint
ALTER INDEX portal_session_user_idx RENAME TO auth_session_user_idx;--> statement-breakpoint
ALTER INDEX portal_session_admin_idx RENAME TO auth_session_admin_idx;--> statement-breakpoint
ALTER INDEX portal_session_staff_idx RENAME TO auth_session_staff_idx;--> statement-breakpoint
CREATE INDEX auth_session_purge_idx ON auth_session (expires_at);--> statement-breakpoint
INSERT INTO auth_session (id, user_id, created_at, expires_at, revoked_at)
  SELECT id, user_id, created_at, expires_at, revoked_at FROM customer_session
  ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
DROP TABLE customer_session;--> statement-breakpoint

-- Customer rule: role change or any status other than active revokes. No audit row (unchanged behaviour).
CREATE OR REPLACE FUNCTION revoke_customer_sessions_on_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'customer' AND (NEW.role IS DISTINCT FROM OLD.role OR
     (NEW.account_status IS DISTINCT FROM OLD.account_status AND NEW.account_status <> 'active')) THEN
    UPDATE auth_session SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_status_session_revocation AFTER UPDATE OF account_status, role ON "user"
FOR EACH ROW EXECUTE FUNCTION revoke_customer_sessions_on_status_change();--> statement-breakpoint

-- Client and admin rule, unchanged except that it now reads auth_session and skips customer rows.
CREATE OR REPLACE FUNCTION revoke_changed_portal_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  IF TG_TABLE_NAME='user' THEN
    IF OLD.role = 'client' AND (OLD.role IS DISTINCT FROM NEW.role OR OLD.email IS DISTINCT FROM NEW.email
       OR (OLD.account_status IS DISTINCT FROM NEW.account_status
           AND NOT (OLD.account_status='pending_application' AND NEW.account_status='active'))) THEN
      UPDATE auth_session SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
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
      UPDATE auth_session SET revoked_at=now() WHERE admin_id=NEW.id AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected>0 THEN
        INSERT INTO audit_log(actor_type,entity,entity_id,action,after)
        VALUES ('system','admin_user',NEW.id::text,'access_sessions_revoked',jsonb_build_object('count',affected));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 4. FKs that prove the referenced user has the right role.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM booking_order o JOIN "user" u ON u.id = o.customer_id WHERE u.role <> 'customer';
  IF n > 0 THEN RAISE EXCEPTION '0043: % orders belong to a non-customer account', n; END IF;
  SELECT count(*) INTO n FROM rentable r JOIN "user" u ON u.id = r.client_id WHERE u.role <> 'client';
  IF n > 0 THEN RAISE EXCEPTION '0043: % listings belong to a non-client account', n; END IF;
  SELECT count(*) INTO n FROM payout p JOIN "user" u ON u.id = p.client_id WHERE u.role <> 'client';
  IF n > 0 THEN RAISE EXCEPTION '0043: % payouts belong to a non-client account', n; END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX user_id_role_idx ON "user" (id, role);--> statement-breakpoint
-- A constant column, not GENERATED: BEFORE UPDATE triggers see generated columns as NULL in NEW.
ALTER TABLE booking_order ADD COLUMN customer_role varchar(16) NOT NULL DEFAULT 'customer' CONSTRAINT booking_order_customer_role_chk CHECK (customer_role = 'customer');--> statement-breakpoint
ALTER TABLE booking_order ADD CONSTRAINT booking_order_customer_role_fk
  FOREIGN KEY (customer_id, customer_role) REFERENCES "user" (id, role) ON DELETE RESTRICT;--> statement-breakpoint
-- A constant column, not GENERATED: BEFORE UPDATE triggers see generated columns as NULL in NEW.
ALTER TABLE rentable ADD COLUMN client_role varchar(16) NOT NULL DEFAULT 'client' CONSTRAINT rentable_client_role_chk CHECK (client_role = 'client');--> statement-breakpoint
ALTER TABLE rentable ADD CONSTRAINT rentable_client_role_fk
  FOREIGN KEY (client_id, client_role) REFERENCES "user" (id, role) ON DELETE RESTRICT;--> statement-breakpoint
-- A constant column, not GENERATED: BEFORE UPDATE triggers see generated columns as NULL in NEW.
ALTER TABLE payout ADD COLUMN client_role varchar(16) NOT NULL DEFAULT 'client' CONSTRAINT payout_client_role_chk CHECK (client_role = 'client');--> statement-breakpoint
ALTER TABLE payout ADD CONSTRAINT payout_client_role_fk
  FOREIGN KEY (client_id, client_role) REFERENCES "user" (id, role) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_author_user_role_fk
  FOREIGN KEY (author_id, author_role) REFERENCES "user" (id, role) ON DELETE RESTRICT;
