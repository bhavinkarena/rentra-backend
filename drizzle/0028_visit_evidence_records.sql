CREATE TABLE "visit_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"evidence_id" uuid,
	"incident_id" uuid,
	"position" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"bytes" integer NOT NULL,
	"retention_class" varchar(24) NOT NULL,
	"nature" varchar(16) NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_attachment_valid_chk" CHECK ((("visit_attachment"."evidence_id" IS NOT NULL AND "visit_attachment"."incident_id" IS NULL AND "visit_attachment"."retention_class"='visit_evidence')
      OR ("visit_attachment"."incident_id" IS NOT NULL AND "visit_attachment"."evidence_id" IS NULL AND "visit_attachment"."retention_class"='incident_evidence'))
    AND "visit_attachment"."position" BETWEEN 0 AND 2 AND "visit_attachment"."mime_type" IN ('image/jpeg','image/png','image/webp')
    AND "visit_attachment"."bytes" BETWEEN 1 AND 2097152 AND "visit_attachment"."sha256" ~ '^[a-f0-9]{64}$'
    AND "visit_attachment"."nature" IN ('actual','simulation') AND "visit_attachment"."actor_kind" IN ('owner','admin'))
);
--> statement-breakpoint
CREATE TABLE "visit_evidence_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"supersedes_id" uuid,
	"reason" text NOT NULL,
	"corrected_occurred_at" timestamp with time zone,
	"corrected_note" text,
	"nature" varchar(16) NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	CONSTRAINT "visit_evidence_correction_valid_chk" CHECK ("visit_evidence_correction"."actor_kind"='admin' AND "visit_evidence_correction"."nature" IN ('actual','simulation')
    AND length(trim("visit_evidence_correction"."reason")) BETWEEN 10 AND 500 AND "visit_evidence_correction"."request_hash" ~ '^[a-f0-9]{64}$'
    AND ("visit_evidence_correction"."corrected_occurred_at" IS NOT NULL OR "visit_evidence_correction"."corrected_note" IS NOT NULL)
    AND ("visit_evidence_correction"."corrected_note" IS NULL OR length(trim("visit_evidence_correction"."corrected_note")) BETWEEN 20 AND 1000)
    AND ("visit_evidence_correction"."corrected_occurred_at" IS NULL OR "visit_evidence_correction"."corrected_occurred_at" <= "visit_evidence_correction"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "visit_incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(24) NOT NULL,
	"booking_id" uuid NOT NULL,
	"category" varchar(24) NOT NULL,
	"summary" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"nature" varchar(16) NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	CONSTRAINT "visit_incident_valid_chk" CHECK ("visit_incident"."category" IN ('damage','safety','access','conduct','amenity','other')
    AND "visit_incident"."nature" IN ('actual','simulation') AND "visit_incident"."actor_kind" IN ('owner','admin') AND "visit_incident"."state" IN ('open','closed')
    AND length(trim("visit_incident"."summary")) BETWEEN 5 AND 120 AND length(trim("visit_incident"."description")) BETWEEN 20 AND 2000
    AND "visit_incident"."request_hash" ~ '^[a-f0-9]{64}$' AND "visit_incident"."occurred_at" <= "visit_incident"."created_at" AND "visit_incident"."version" >= 1
    AND (("visit_incident"."state"='open' AND "visit_incident"."closed_at" IS NULL AND "visit_incident"."closed_by" IS NULL AND "visit_incident"."resolution_note" IS NULL)
      OR ("visit_incident"."state"='closed' AND "visit_incident"."closed_at" IS NOT NULL AND "visit_incident"."closed_by" IS NOT NULL AND length(trim("visit_incident"."resolution_note")) BETWEEN 10 AND 1000)))
);
--> statement-breakpoint
ALTER TABLE "visit_evidence" ADD COLUMN "visit_version" integer;--> statement-breakpoint
ALTER TABLE "visit_attachment" ADD CONSTRAINT "visit_attachment_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_attachment" ADD CONSTRAINT "visit_attachment_evidence_id_visit_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."visit_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_attachment" ADD CONSTRAINT "visit_attachment_incident_id_visit_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."visit_incident"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_evidence_correction" ADD CONSTRAINT "visit_evidence_correction_evidence_id_visit_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."visit_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_evidence_correction" ADD CONSTRAINT "visit_evidence_correction_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_evidence_correction" ADD CONSTRAINT "visit_evidence_correction_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."visit_evidence_correction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_incident" ADD CONSTRAINT "visit_incident_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_incident" ADD CONSTRAINT "visit_incident_closed_by_admin_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visit_attachment_booking_idx" ON "visit_attachment" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_attachment_evidence_idx" ON "visit_attachment" USING btree ("evidence_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_attachment_incident_idx" ON "visit_attachment" USING btree ("incident_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_evidence_correction_request_idx" ON "visit_evidence_correction" USING btree ("actor_kind","actor_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_evidence_correction_first_idx" ON "visit_evidence_correction" USING btree ("evidence_id") WHERE "visit_evidence_correction"."supersedes_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_evidence_correction_next_idx" ON "visit_evidence_correction" USING btree ("supersedes_id") WHERE "visit_evidence_correction"."supersedes_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_incident_reference_idx" ON "visit_incident" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_incident_request_idx" ON "visit_incident" USING btree ("actor_kind","actor_id","request_key");--> statement-breakpoint
CREATE INDEX "visit_incident_booking_idx" ON "visit_incident" USING btree ("booking_id","created_at");--> statement-breakpoint
-- CP13: evidence records are append-only. Attachments and corrections never change;
-- an incident changes only through its single admin closure.
CREATE TRIGGER visit_attachment_immutable BEFORE UPDATE OR DELETE ON visit_attachment FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER visit_evidence_correction_immutable BEFORE UPDATE OR DELETE ON visit_evidence_correction FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER visit_incident_immutable BEFORE UPDATE OR DELETE ON visit_incident FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','resolution_note','closed_at','closed_by','version','updated_at');
--> statement-breakpoint
CREATE FUNCTION rentra_visit_operator_valid(v booking, kind text, actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE kind
    WHEN 'owner' THEN EXISTS(SELECT 1 FROM rentable r JOIN "user" u ON u.id=r.client_id
      WHERE r.id=v.rentable_id AND u.id=actor AND u.role='client' AND u.account_status='active')
    WHEN 'admin' THEN EXISTS(SELECT 1 FROM admin_user WHERE id=actor AND is_active)
    ELSE false END
$$;
--> statement-breakpoint
CREATE FUNCTION rentra_visit_incident_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v booking;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.state='closed' OR NEW.state<>'closed' OR NEW.version<>OLD.version+1
      OR NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.closed_by AND is_active) THEN
      RAISE EXCEPTION 'Invalid incident closure' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v FROM booking WHERE id=NEW.booking_id;
  IF v.order_id IS NULL OR NOT v.hours_known OR v.state::text NOT IN ('confirmed','handed_over','returned','completed','disputed')
    OR NEW.state<>'open' OR NEW.version<>1 OR NEW.occurred_at<v.starts_at-interval '1 day' OR NEW.occurred_at>clock_timestamp()
    OR NEW.nature IS DISTINCT FROM (CASE WHEN v.visit_provenance='real' THEN 'actual' ELSE 'simulation' END) THEN
    RAISE EXCEPTION 'Invalid incident scope' USING ERRCODE='23514';
  END IF;
  IF NOT rentra_visit_operator_valid(v, NEW.actor_kind, NEW.actor_id) THEN
    RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER visit_incident_scope BEFORE INSERT OR UPDATE ON visit_incident FOR EACH ROW EXECUTE FUNCTION rentra_visit_incident_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_visit_correction_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e visit_evidence; v booking; p visit_evidence_correction;
BEGIN
  SELECT * INTO STRICT e FROM visit_evidence WHERE id=NEW.evidence_id;
  SELECT * INTO STRICT v FROM booking WHERE id=e.booking_id;
  -- A correction inherits the original's nature: Test evidence can never become actual evidence.
  IF NEW.booking_id<>e.booking_id OR NEW.nature<>e.nature
    OR (NEW.corrected_occurred_at IS NOT NULL AND (NEW.corrected_occurred_at<v.starts_at OR NEW.corrected_occurred_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'Invalid evidence correction scope' USING ERRCODE='23514';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO STRICT p FROM visit_evidence_correction WHERE id=NEW.supersedes_id;
    IF p.evidence_id<>NEW.evidence_id THEN RAISE EXCEPTION 'Invalid correction chain' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT rentra_visit_operator_valid(v, NEW.actor_kind, NEW.actor_id) THEN
    RAISE EXCEPTION 'Invalid visit operator' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER visit_evidence_correction_scope BEFORE INSERT ON visit_evidence_correction FOR EACH ROW EXECUTE FUNCTION rentra_visit_correction_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_visit_attachment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p_booking uuid; p_nature text; p_kind text; p_actor uuid; p_state text;
BEGIN
  IF NEW.evidence_id IS NOT NULL THEN
    SELECT booking_id,nature::text,actor_kind::text,actor_id,'open' INTO p_booking,p_nature,p_kind,p_actor,p_state
      FROM visit_evidence WHERE id=NEW.evidence_id;
  ELSE
    SELECT booking_id,nature::text,actor_kind::text,actor_id,state::text INTO p_booking,p_nature,p_kind,p_actor,p_state
      FROM visit_incident WHERE id=NEW.incident_id;
  END IF;
  IF p_booking IS NULL OR p_booking<>NEW.booking_id OR p_nature<>NEW.nature
    OR p_kind<>NEW.actor_kind OR p_actor<>NEW.actor_id OR p_state<>'open' THEN
    RAISE EXCEPTION 'Invalid attachment scope' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM visit_attachment WHERE booking_id=NEW.booking_id)>=30 THEN
    RAISE EXCEPTION 'Visit attachment limit reached' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER visit_attachment_scope BEFORE INSERT ON visit_attachment FOR EACH ROW EXECUTE FUNCTION rentra_visit_attachment_scope();
