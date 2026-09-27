CREATE TABLE "payout_destination" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"method" varchar(8) NOT NULL,
	"holder_name" varchar(160) NOT NULL,
	"account_last4" varchar(4),
	"ifsc" varchar(11),
	"upi_id" varchar(100),
	"name_check" varchar(12) NOT NULL,
	"state" varchar(12) DEFAULT 'draft' NOT NULL,
	"source" varchar(16) NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"failure_reason" text,
	"verification_provider" varchar(32),
	"verification_reference" varchar(160),
	"verification_evidence_hash" varchar(64),
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_key" uuid,
	"request_hash" varchar(64),
	CONSTRAINT "payout_destination_valid_chk" CHECK ("payout_destination"."version" >= 1 AND length(trim("payout_destination"."holder_name")) BETWEEN 3 AND 160
    AND "payout_destination"."name_check" IN ('same','different','unknown') AND "payout_destination"."source" IN ('onboarding','settings','migration')
    AND "payout_destination"."state" IN ('draft','submitted','verified','failed','superseded')
    AND (("payout_destination"."method"='bank' AND "payout_destination"."account_last4" ~ '^[0-9]{4}$' AND "payout_destination"."ifsc" ~ '^[A-Z]{4}0[A-Z0-9]{6}$' AND "payout_destination"."upi_id" IS NULL)
      OR ("payout_destination"."method"='upi' AND "payout_destination"."upi_id" ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$' AND "payout_destination"."account_last4" IS NULL AND "payout_destination"."ifsc" IS NULL))
    AND (("payout_destination"."state"='draft') = ("payout_destination"."submitted_at" IS NULL))
    AND ("payout_destination"."state"<>'failed' OR ("payout_destination"."decided_at" IS NOT NULL AND length(trim("payout_destination"."failure_reason")) BETWEEN 10 AND 500))
    AND ("payout_destination"."state"<>'verified' OR ("payout_destination"."verification_provider" IS NOT NULL AND "payout_destination"."verification_reference" IS NOT NULL
      AND "payout_destination"."verification_evidence_hash" ~ '^[a-f0-9]{64}$' AND "payout_destination"."verified_at" IS NOT NULL))
    AND (("payout_destination"."request_key" IS NULL) = ("payout_destination"."request_hash" IS NULL))
    AND ("payout_destination"."request_hash" IS NULL OR "payout_destination"."request_hash" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "payout_destination" ADD CONSTRAINT "payout_destination_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destination" ADD CONSTRAINT "payout_destination_decided_by_admin_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_version_idx" ON "payout_destination" USING btree ("client_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_request_idx" ON "payout_destination" USING btree ("client_id","request_key") WHERE "payout_destination"."request_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_draft_idx" ON "payout_destination" USING btree ("client_id") WHERE "payout_destination"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destination_current_idx" ON "payout_destination" USING btree ("client_id") WHERE "payout_destination"."state" IN ('submitted','verified');--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_destination_id_payout_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."payout_destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- CP21: destination versions are append-only; only the state moves, along allowed paths.
CREATE TRIGGER payout_destination_immutable BEFORE UPDATE OR DELETE ON payout_destination FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','submitted_at','decided_at','decided_by','failure_reason','verification_provider','verification_reference','verification_evidence_hash','verified_at','updated_at');
--> statement-breakpoint
CREATE FUNCTION rentra_payout_destination_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.client_id AND role='client')
      OR (NEW.source<>'migration' AND NEW.state NOT IN ('draft','submitted'))
      OR NEW.version <> (SELECT coalesce(max(version),0)+1 FROM payout_destination WHERE client_id=NEW.client_id) THEN
      RAISE EXCEPTION 'Invalid payout destination version' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state='draft' AND NEW.state IN ('submitted','superseded'))
      OR (OLD.state='submitted' AND NEW.state IN ('verified','failed','superseded'))
      OR (OLD.state='verified' AND NEW.state IN ('failed','superseded'))) THEN
    RAISE EXCEPTION 'Invalid payout destination transition' USING ERRCODE='23514';
  END IF;
  IF NEW.state='failed' AND OLD.state<>'failed' AND NEW.decided_by IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.decided_by AND is_active) THEN
    RAISE EXCEPTION 'Invalid payout destination decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payout_destination_scope BEFORE INSERT OR UPDATE ON payout_destination FOR EACH ROW EXECUTE FUNCTION rentra_payout_destination_scope();
--> statement-breakpoint
-- Obligations keep their pinned version; money can only move to a verified destination.
CREATE FUNCTION rentra_payout_destination_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d_client uuid; d_state text;
BEGIN
  IF NEW.destination_id IS NOT NULL THEN
    SELECT client_id,state INTO d_client,d_state FROM payout_destination WHERE id=NEW.destination_id;
    IF d_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'Payout destination belongs to another client' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.destination_id IS NOT NULL AND NEW.destination_id IS DISTINCT FROM OLD.destination_id THEN
    RAISE EXCEPTION 'A pinned payout destination cannot be redirected' USING ERRCODE='23514';
  END IF;
  IF (TG_OP='INSERT' AND NEW.funding_allocation_id IS NOT NULL AND (NEW.destination_id IS NULL OR d_state<>'verified'))
    OR (TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('processing','paid')
      AND (NEW.destination_id IS NULL OR d_state IS DISTINCT FROM 'verified')) THEN
    RAISE EXCEPTION 'Disbursement requires a verified payout destination' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payout_destination_guard BEFORE INSERT OR UPDATE ON payout FOR EACH ROW EXECUTE FUNCTION rentra_payout_destination_guard();
--> statement-breakpoint
-- Existing details become version 1, submitted and unverified. Rows that do not meet the
-- destination checks are left in the legacy columns for the owner to resubmit.
INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,upi_id,name_check,state,source,submitted_at,created_at,updated_at)
SELECT client_id,1,method,holder_name,account_last4,ifsc,upi_id,name_check,'submitted','migration',submitted_at,now(),now() FROM (
  SELECT u.id client_id,
    CASE WHEN coalesce(a.payout_upi_id,u.payout_upi_id) IS NOT NULL THEN 'upi' ELSE 'bank' END method,
    trim(coalesce(a.payout_holder_name,u.name,'')) holder_name,
    CASE WHEN coalesce(a.payout_upi_id,u.payout_upi_id) IS NULL THEN right(regexp_replace(coalesce(a.payout_account_ref,u.payout_bank_ref,''),'[^0-9]','','g'),4) END account_last4,
    CASE WHEN coalesce(a.payout_upi_id,u.payout_upi_id) IS NULL THEN upper(a.payout_ifsc) END ifsc,
    lower(coalesce(a.payout_upi_id,u.payout_upi_id)) upi_id,
    CASE a.payout_name_match WHEN true THEN 'same' WHEN false THEN 'different' ELSE 'unknown' END name_check,
    coalesce(a.updated_at,u.updated_at,now()) submitted_at
  FROM "user" u LEFT JOIN client_application a ON a.user_id=u.id
  WHERE u.role='client' AND (coalesce(a.payout_upi_id,u.payout_upi_id) IS NOT NULL OR coalesce(a.payout_account_ref,u.payout_bank_ref) IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM payout_destination d WHERE d.client_id=u.id)
) c
WHERE length(holder_name) BETWEEN 3 AND 160
  AND ((method='upi' AND upi_id ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$')
    OR (method='bank' AND account_last4 ~ '^[0-9]{4}$' AND ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'));
