CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"booking_id" uuid,
	"customer_id" uuid NOT NULL,
	"event_key" varchar(160) NOT NULL,
	"template" varchar(24) NOT NULL,
	"channel" varchar(16) DEFAULT 'sms' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"provider_id" varchar(40),
	"provider_account" varchar(40),
	"recipient" varchar(20),
	"sender" varchar(20),
	"body_hash" varchar(64),
	"failure_code" varchar(64),
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_valid_chk" CHECK ("notification_outbox"."template" IN ('confirmation','reminder','cancellation','refund','completion','review_invitation')
    AND "notification_outbox"."channel"='sms' AND "notification_outbox"."attempts">=0 AND "notification_outbox"."state" IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed'))
);
--> statement-breakpoint
CREATE TABLE "visit_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"nature" varchar(16) NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" uuid NOT NULL,
	"note" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	CONSTRAINT "visit_evidence_valid_chk" CHECK ("visit_evidence"."kind" IN ('handover','return','complete') AND "visit_evidence"."nature" IN ('actual','simulation')
    AND "visit_evidence"."actor_kind" IN ('owner','admin') AND length(trim("visit_evidence"."note")) BETWEEN 20 AND 1000
    AND "visit_evidence"."request_hash" ~ '^[a-f0-9]{64}$' AND "visit_evidence"."occurred_at" <= "visit_evidence"."recorded_at")
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_evidence" ADD CONSTRAINT "visit_evidence_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_recipient_idx" ON "notification_outbox" USING btree ("event_key","customer_id","channel");--> statement-breakpoint
CREATE INDEX "notification_due_idx" ON "notification_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_customer_idx" ON "notification_outbox" USING btree ("customer_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_evidence_kind_idx" ON "visit_evidence" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_evidence_request_idx" ON "visit_evidence" USING btree ("actor_kind","actor_id","request_key");
--> statement-breakpoint
CREATE TRIGGER visit_evidence_immutable BEFORE UPDATE OR DELETE ON visit_evidence FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER notification_terms_immutable BEFORE UPDATE OR DELETE ON notification_outbox FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','attempts','next_attempt_at','lease_token','lease_until','provider_id','provider_account','recipient','sender','body_hash','failure_code','delivered_at','read_at');
--> statement-breakpoint
CREATE FUNCTION rentra_visit_evidence_scope() RETURNS trigger LANGUAGE plpgsql AS $$
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
--> statement-breakpoint
CREATE TRIGGER visit_evidence_scope BEFORE INSERT ON visit_evidence FOR EACH ROW EXECUTE FUNCTION rentra_visit_evidence_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_visit_transition_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phase text;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.order_id IS NOT NULL THEN
    phase=CASE NEW.state WHEN 'handed_over' THEN 'handover' WHEN 'returned' THEN 'return' WHEN 'completed' THEN 'complete' ELSE NULL END;
    IF phase IS NOT NULL AND (OLD.state::text IS DISTINCT FROM (CASE phase WHEN 'handover' THEN 'confirmed' WHEN 'return' THEN 'handed_over' ELSE 'returned' END)
      OR NOT EXISTS(SELECT 1 FROM visit_evidence WHERE booking_id=NEW.id AND kind=phase)) THEN
      RAISE EXCEPTION 'Visit transition requires recorded evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER visit_transition_proof BEFORE UPDATE OF state ON booking FOR EACH ROW EXECUTE FUNCTION rentra_visit_transition_proof();
--> statement-breakpoint
CREATE FUNCTION rentra_notification_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM booking_order WHERE id=NEW.order_id AND customer_id=NEW.customer_id)
    OR (NEW.booking_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND order_id=NEW.order_id AND customer_id=NEW.customer_id)) THEN
    RAISE EXCEPTION 'Notification scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER notification_scope BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION rentra_notification_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer uuid; template_name text; proof visit_evidence;
BEGIN
  SELECT customer_id INTO STRICT customer FROM booking_order WHERE id=NEW.order_id;
  template_name=CASE WHEN NEW.kind='confirmed' THEN 'confirmation' WHEN NEW.kind LIKE 'cancel_%' THEN 'cancellation'
    WHEN NEW.kind LIKE 'refund_%' THEN 'refund' ELSE NULL END;
  IF template_name IS NOT NULL THEN
    INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at)
      VALUES(NEW.order_id,customer,'event:'||NEW.id,template_name,clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.kind='confirmed' THEN
    INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
      SELECT NEW.order_id,b.id,customer,'reminder:'||b.id,'reminder',greatest(clock_timestamp(),b.starts_at-interval '24 hours')
      FROM booking b WHERE b.order_id=NEW.order_id AND b.state='confirmed' AND b.starts_at>clock_timestamp() ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.kind LIKE 'cancel_%' THEN
    UPDATE notification_outbox n SET state='suppressed',failure_code='VISIT_CANCELLED'
      WHERE n.order_id=NEW.order_id AND n.template IN ('reminder','review_invitation') AND n.state IN ('pending','blocked','retry','failed')
      AND EXISTS(SELECT 1 FROM booking b WHERE b.id=n.booking_id AND b.state='cancelled');
  END IF;
  IF NEW.kind LIKE 'visit_%' AND NEW.payload->>'phase'='complete' THEN
    SELECT * INTO proof FROM visit_evidence WHERE id=(NEW.payload->>'evidenceId')::uuid AND kind='complete'
      AND booking_id IN (SELECT id FROM booking WHERE order_id=NEW.order_id);
    IF proof.id IS NOT NULL THEN
      INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
        VALUES(NEW.order_id,proof.booking_id,customer,'complete:'||proof.booking_id,'completion',clock_timestamp()) ON CONFLICT DO NOTHING;
      IF proof.nature='actual' THEN
        INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
          VALUES(NEW.order_id,proof.booking_id,customer,'review:'||proof.booking_id,'review_invitation',clock_timestamp()) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_notification_event AFTER INSERT ON booking_lifecycle_event FOR EACH ROW EXECUTE FUNCTION rentra_notification_event();
--> statement-breakpoint
-- Existing upcoming visits receive one reminder; do not replay historical confirmations.
INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
  SELECT b.order_id,b.id,b.customer_id,'reminder:'||b.id,'reminder',greatest(clock_timestamp(),b.starts_at-interval '24 hours')
  FROM booking b WHERE b.order_id IS NOT NULL AND b.state='confirmed' AND b.hours_known AND b.starts_at>clock_timestamp()
  ON CONFLICT DO NOTHING;
