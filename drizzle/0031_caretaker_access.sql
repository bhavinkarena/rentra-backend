ALTER TYPE "public"."audit_actor" ADD VALUE 'staff';--> statement-breakpoint
CREATE TABLE "staff_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invitation_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_property" (
	"staff_id" uuid NOT NULL,
	"rentable_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_property_staff_id_rentable_id_pk" PRIMARY KEY("staff_id","rentable_id")
);
--> statement-breakpoint
ALTER TABLE "portal_session" DROP CONSTRAINT "portal_session_principal_chk";--> statement-breakpoint
ALTER TABLE "visit_attachment" DROP CONSTRAINT "visit_attachment_valid_chk";--> statement-breakpoint
ALTER TABLE "visit_evidence" DROP CONSTRAINT "visit_evidence_valid_chk";--> statement-breakpoint
ALTER TABLE "client_staff" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_staff" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_staff" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "client_staff" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "client_staff" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_session" ADD COLUMN "staff_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_staff_id_client_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."client_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_property" ADD CONSTRAINT "staff_property_staff_id_client_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."client_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_property" ADD CONSTRAINT "staff_property_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_invitation_staff_idx" ON "staff_invitation" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "staff_property_rentable_idx" ON "staff_property" USING btree ("rentable_id");--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_staff_id_client_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."client_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_session_staff_idx" ON "portal_session" USING btree ("staff_id");--> statement-breakpoint
ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_principal_chk" CHECK ((("portal_session"."user_id" IS NOT NULL)::int + ("portal_session"."admin_id" IS NOT NULL)::int + ("portal_session"."staff_id" IS NOT NULL)::int) = 1);--> statement-breakpoint
ALTER TABLE "visit_attachment" ADD CONSTRAINT "visit_attachment_valid_chk" CHECK ((("visit_attachment"."evidence_id" IS NOT NULL AND "visit_attachment"."incident_id" IS NULL AND "visit_attachment"."retention_class"='visit_evidence')
      OR ("visit_attachment"."incident_id" IS NOT NULL AND "visit_attachment"."evidence_id" IS NULL AND "visit_attachment"."retention_class"='incident_evidence'))
    AND "visit_attachment"."position" BETWEEN 0 AND 2 AND "visit_attachment"."mime_type" IN ('image/jpeg','image/png','image/webp')
    AND "visit_attachment"."bytes" BETWEEN 1 AND 2097152 AND "visit_attachment"."sha256" ~ '^[a-f0-9]{64}$'
    AND "visit_attachment"."nature" IN ('actual','simulation') AND "visit_attachment"."actor_kind" IN ('owner','admin','staff'));--> statement-breakpoint
ALTER TABLE "visit_evidence" ADD CONSTRAINT "visit_evidence_valid_chk" CHECK ("visit_evidence"."kind" IN ('handover','return','complete') AND "visit_evidence"."nature" IN ('actual','simulation')
    AND "visit_evidence"."actor_kind" IN ('owner','admin','staff') AND length(trim("visit_evidence"."note")) BETWEEN 20 AND 1000
    AND "visit_evidence"."request_hash" ~ '^[a-f0-9]{64}$' AND "visit_evidence"."occurred_at" <= "visit_evidence"."recorded_at");--> statement-breakpoint
-- CP16: the database also enforces caretaker scope for evidence. A caretaker
-- may record a transition only while active, accepted, granted evidence, assigned
-- to this property and working for its (active) owner. Same function as 0017
-- with the caretaker branch added.
CREATE OR REPLACE FUNCTION rentra_visit_evidence_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v booking; owner_id uuid; prior_time timestamptz; expected_state text;
BEGIN
  SELECT * INTO STRICT v FROM booking WHERE id=NEW.booking_id;
  SELECT client_id INTO owner_id FROM rentable WHERE id=v.rentable_id;
  IF NOT v.hours_known OR v.order_id IS NULL OR NEW.occurred_at<v.starts_at OR NEW.occurred_at>clock_timestamp()
    OR NEW.nature IS DISTINCT FROM (CASE WHEN v.visit_provenance='real' THEN 'actual' ELSE 'simulation' END) THEN
    RAISE EXCEPTION 'Invalid visit evidence scope' USING ERRCODE='23514';
  END IF;
  IF NEW.actor_kind='owner' THEN
    IF NEW.actor_id<>owner_id OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.actor_id AND role='client' AND account_status='active') THEN
      RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
    END IF;
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
