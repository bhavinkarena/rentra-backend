CREATE TABLE "support_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachment_valid_chk" CHECK ("support_attachment"."mime_type" IN ('image/jpeg','image/png','image/webp') AND "support_attachment"."bytes" BETWEEN 1 AND 2097152 AND "support_attachment"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "support_message" DROP CONSTRAINT "support_message_valid_chk";--> statement-breakpoint
ALTER TABLE "support_request" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_message" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "property_id" uuid;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "priority" varchar(16) DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "related_request_id" uuid;--> statement-breakpoint
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_message_id_support_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_attachment_message_hash_idx" ON "support_attachment" USING btree ("message_id","sha256");--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_property_id_rentable_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_assigned_to_admin_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_related_request_id_support_request_id_fk" FOREIGN KEY ("related_request_id") REFERENCES "public"."support_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_request_client_replay_idx" ON "support_request" USING btree ("client_id","request_key");--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_valid_chk" CHECK ("support_message"."actor_kind" IN ('customer','owner','admin') AND (NOT "support_message"."internal" OR "support_message"."actor_kind"='admin') AND length(trim("support_message"."body")) BETWEEN 2 AND 5000
    AND "support_message"."state_after" IN ('open','in_progress','waiting_customer','resolved') AND "support_message"."request_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_participant_chk" CHECK (num_nonnulls("support_request"."customer_id","support_request"."client_id")=1 AND ("support_request"."client_id" IS NULL OR "support_request"."privacy_request_id" IS NULL) AND "support_request"."priority" IN ('normal','urgent') AND ("support_request"."related_request_id" IS NULL OR "support_request"."related_request_id"<>"support_request"."id"));--> statement-breakpoint
DROP TRIGGER support_request_terms_immutable ON support_request;
--> statement-breakpoint
CREATE TRIGGER support_request_terms_immutable BEFORE UPDATE OR DELETE ON support_request FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','version','updated_at','assigned_to','priority','related_request_id');
--> statement-breakpoint
CREATE TRIGGER support_attachment_immutable BEFORE UPDATE OR DELETE ON support_attachment FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_support_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant support_request%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='support_request' THEN
  IF NEW.state<>'open' OR NEW.version<>0 THEN RAISE EXCEPTION 'Invalid initial support state' USING ERRCODE='23514'; END IF;
  IF NEW.client_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.client_id AND role='client' AND account_status='active')
    OR (NEW.property_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rentable WHERE id=NEW.property_id AND client_id=NEW.client_id))
    OR (NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=NEW.order_id AND r.client_id=NEW.client_id AND (NEW.property_id IS NULL OR NEW.property_id=r.id)))
   THEN RAISE EXCEPTION 'Invalid support client scope' USING ERRCODE='23514'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.customer_id AND role='customer' AND account_status='active')
    OR NEW.property_id IS NOT NULL
    OR (NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_order WHERE id=NEW.order_id AND customer_id=NEW.customer_id))
    OR (NEW.privacy_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_privacy_request WHERE id=NEW.privacy_request_id AND customer_id=NEW.customer_id))
   THEN RAISE EXCEPTION 'Invalid support customer scope' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  SELECT * INTO STRICT participant FROM support_request WHERE id=NEW.request_id;
  IF NEW.actor_kind='admin' THEN
   IF NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active=true AND (permissions IS NULL OR permissions @> '["admin.support.write"]'::jsonb)) THEN RAISE EXCEPTION 'Invalid support administrator' USING ERRCODE='23514'; END IF;
  ELSE
   IF NEW.internal OR NEW.state_after NOT IN ('open','resolved')
    OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.actor_id AND account_status='active' AND ((NEW.actor_kind='owner' AND role='client' AND id=participant.client_id) OR (NEW.actor_kind='customer' AND role='customer' AND id=participant.customer_id)))
   THEN RAISE EXCEPTION 'Invalid support participant' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION client_update_from_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request support_request%ROWTYPE;
BEGIN
 IF NEW.actor_kind='admin' AND NOT NEW.internal THEN
  SELECT * INTO STRICT request FROM support_request WHERE id=NEW.request_id;
  IF request.client_id IS NOT NULL THEN
   PERFORM client_update_insert(request.client_id,'support:'||NEW.id,'case',
    CASE WHEN NEW.state_after='waiting_customer' THEN 'action' ELSE 'info' END,
    'support_reply',request.property_id,request.order_id,jsonb_build_object('supportId',request.id),NEW.created_at);
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_update_support_message AFTER INSERT ON support_message FOR EACH ROW EXECUTE FUNCTION client_update_from_support();
