CREATE TABLE "dispute_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_attachment_valid_chk" CHECK ("dispute_attachment"."mime_type" IN ('image/jpeg','image/png','image/webp') AND "dispute_attachment"."bytes" BETWEEN 1 AND 2097152 AND "dispute_attachment"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "dispute_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"subject" varchar(160) NOT NULL,
	"claimed_minor" bigint DEFAULT 0 NOT NULL,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"requested_party" varchar(16),
	"response_due" timestamp with time zone,
	"outcome" varchar(24),
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_kind" varchar(16) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_case_valid_chk" CHECK ("dispute_case"."kind" IN ('service','deposit','provider') AND length(trim("dispute_case"."subject")) BETWEEN 5 AND 160 AND "dispute_case"."claimed_minor" BETWEEN 0 AND 100000000
    AND "dispute_case"."state" IN ('open','resolved') AND "dispute_case"."version" >= 1 AND "dispute_case"."created_by_kind" IN ('owner','customer','admin') AND "dispute_case"."request_hash" ~ '^[a-f0-9]{64}$'
    AND (("dispute_case"."requested_party" IS NULL AND "dispute_case"."response_due" IS NULL) OR ("dispute_case"."requested_party" IN ('owner','customer') AND "dispute_case"."response_due" IS NOT NULL))
    AND (("dispute_case"."state"='open' AND "dispute_case"."outcome" IS NULL AND "dispute_case"."resolution" IS NULL AND "dispute_case"."resolved_by" IS NULL AND "dispute_case"."resolved_at" IS NULL)
      OR ("dispute_case"."state"='resolved' AND "dispute_case"."outcome" IN ('no_action','refund_review','support_escalation') AND length(trim("dispute_case"."resolution")) BETWEEN 10 AND 2000 AND "dispute_case"."resolved_by" IS NOT NULL AND "dispute_case"."resolved_at" IS NOT NULL AND "dispute_case"."requested_party" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "dispute_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"audience" varchar(16) NOT NULL,
	"body" text NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_message_valid_chk" CHECK ("dispute_message"."actor_kind" IN ('owner','customer','admin') AND "dispute_message"."kind" IN ('created','reply','assigned','requested','resolved') AND "dispute_message"."audience" IN ('owner','customer','everyone','internal') AND ("dispute_message"."actor_kind"='admin' OR "dispute_message"."audience"="dispute_message"."actor_kind") AND length(trim("dispute_message"."body")) BETWEEN 2 AND 2000 AND "dispute_message"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "dispute_attachment" ADD CONSTRAINT "dispute_attachment_message_id_dispute_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."dispute_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_visit_id_booking_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_assignee_id_admin_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_case" ADD CONSTRAINT "dispute_case_resolved_by_admin_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_message" ADD CONSTRAINT "dispute_message_case_id_dispute_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."dispute_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_attachment_hash_idx" ON "dispute_attachment" USING btree ("message_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_case_request_idx" ON "dispute_case" USING btree ("created_by_kind","created_by_id","request_key");--> statement-breakpoint
CREATE INDEX "dispute_case_queue_idx" ON "dispute_case" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "dispute_case_owner_idx" ON "dispute_case" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "dispute_case_customer_idx" ON "dispute_case" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_message_request_idx" ON "dispute_message" USING btree ("case_id","actor_kind","actor_id","request_key");--> statement-breakpoint
CREATE INDEX "dispute_message_case_idx" ON "dispute_message" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE TRIGGER dispute_case_immutable BEFORE UPDATE OR DELETE ON dispute_case FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('state','assignee_id','requested_party','response_due','outcome','resolution','resolved_by','resolved_at','version','updated_at');
--> statement-breakpoint
CREATE TRIGGER dispute_message_immutable BEFORE UPDATE OR DELETE ON dispute_message FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER dispute_attachment_immutable BEFORE UPDATE OR DELETE ON dispute_attachment FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE FUNCTION rentra_dispute_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c dispute_case; o booking_order; owner uuid;
BEGIN
 IF TG_TABLE_NAME='dispute_case' THEN
  IF TG_OP='INSERT' THEN
   SELECT * INTO STRICT o FROM booking_order WHERE id=NEW.order_id;
   SELECT client_id INTO STRICT owner FROM rentable WHERE id=o.rentable_id;
   IF NEW.customer_id<>o.customer_id OR NEW.owner_id<>owner OR NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.visit_id AND order_id=o.id)
    OR NEW.state<>'open' OR NEW.version<>1 OR NEW.assignee_id IS NOT NULL
    OR (NEW.created_by_kind='owner' AND NEW.created_by_id<>NEW.owner_id)
    OR (NEW.created_by_kind='customer' AND NEW.created_by_id<>NEW.customer_id)
   THEN RAISE EXCEPTION 'Invalid dispute scope' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='resolved' OR NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'Dispute is resolved or version is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.assignee_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.assignee_id AND is_active AND (permissions IS NULL OR permissions @> '["admin.payments.write"]'::jsonb)) THEN
   RAISE EXCEPTION 'Invalid dispute assignee' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO STRICT c FROM dispute_case WHERE id=NEW.case_id;
  IF (NEW.actor_kind='owner' AND NEW.actor_id<>c.owner_id) OR (NEW.actor_kind='customer' AND NEW.actor_id<>c.customer_id)
    OR (NEW.actor_kind='admin' AND NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active AND (permissions IS NULL OR permissions @> '["admin.payments.write"]'::jsonb))) THEN
   RAISE EXCEPTION 'Invalid dispute message actor' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dispute_case_scope BEFORE INSERT OR UPDATE ON dispute_case FOR EACH ROW EXECUTE FUNCTION rentra_dispute_scope();
--> statement-breakpoint
CREATE TRIGGER dispute_message_scope BEFORE INSERT ON dispute_message FOR EACH ROW EXECUTE FUNCTION rentra_dispute_scope();
