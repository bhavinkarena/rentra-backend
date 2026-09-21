CREATE TABLE "support_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"body" text NOT NULL,
	"state_after" varchar(20) NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_message_valid_chk" CHECK ("support_message"."actor_kind" IN ('customer','admin') AND length(trim("support_message"."body")) BETWEEN 2 AND 5000
    AND "support_message"."state_after" IN ('open','in_progress','waiting_customer','resolved') AND "support_message"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "support_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(40) NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"privacy_request_id" uuid,
	"category" varchar(24) NOT NULL,
	"subject" varchar(120) NOT NULL,
	"context" jsonb NOT NULL,
	"policy_version" varchar(32) NOT NULL,
	"state" varchar(20) DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_request_reference_unique" UNIQUE("reference"),
	CONSTRAINT "support_request_valid_chk" CHECK ("support_request"."category" IN ('booking','change','cancellation','payment','privacy','other')
    AND "support_request"."state" IN ('open','in_progress','waiting_customer','resolved') AND "support_request"."version">=0
    AND length(trim("support_request"."subject")) BETWEEN 5 AND 120 AND "support_request"."request_hash" ~ '^[a-f0-9]{64}$'
    AND ("support_request"."category" NOT IN ('booking','change','cancellation','payment') OR "support_request"."order_id" IS NOT NULL)
    AND ("support_request"."privacy_request_id" IS NULL OR ("support_request"."category"='privacy' AND "support_request"."order_id" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_request_id_support_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."support_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_privacy_request_id_customer_privacy_request_id_fk" FOREIGN KEY ("privacy_request_id") REFERENCES "public"."customer_privacy_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_message_replay_idx" ON "support_message" USING btree ("actor_kind","actor_id","request_key");--> statement-breakpoint
CREATE INDEX "support_message_thread_idx" ON "support_message" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_request_replay_idx" ON "support_request" USING btree ("customer_id","request_key");--> statement-breakpoint
CREATE INDEX "support_request_inbox_idx" ON "support_request" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "support_request_customer_idx" ON "support_request" USING btree ("customer_id","created_at");
--> statement-breakpoint
CREATE TRIGGER support_request_terms_immutable BEFORE UPDATE OR DELETE ON support_request FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','version','updated_at');
--> statement-breakpoint
CREATE TRIGGER support_message_immutable BEFORE UPDATE OR DELETE ON support_message FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE FUNCTION rentra_support_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer uuid;
BEGIN
  IF TG_TABLE_NAME='support_request' THEN
    IF NOT EXISTS(SELECT 1 FROM "user" WHERE id=NEW.customer_id AND role='customer' AND account_status='active')
      OR (NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking_order WHERE id=NEW.order_id AND customer_id=NEW.customer_id))
      OR (NEW.privacy_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_privacy_request WHERE id=NEW.privacy_request_id AND customer_id=NEW.customer_id))
      OR NEW.state<>'open' OR NEW.version<>0 THEN
      RAISE EXCEPTION 'Invalid support request scope' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT customer_id INTO STRICT customer FROM support_request WHERE id=NEW.request_id;
    IF NEW.actor_kind='customer' THEN
      IF NEW.actor_id<>customer OR NEW.state_after NOT IN ('open','resolved') OR NOT EXISTS(SELECT 1 FROM "user" WHERE id=customer AND role='customer' AND account_status='active') THEN
        RAISE EXCEPTION 'Invalid support message customer' USING ERRCODE='23514';
      END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.actor_id AND is_active=true) THEN
      RAISE EXCEPTION 'Invalid support message administrator' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER support_request_scope BEFORE INSERT ON support_request FOR EACH ROW EXECUTE FUNCTION rentra_support_scope();
--> statement-breakpoint
CREATE TRIGGER support_message_scope BEFORE INSERT ON support_message FOR EACH ROW EXECUTE FUNCTION rentra_support_scope();
