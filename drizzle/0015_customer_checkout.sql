CREATE TABLE "booking_lifecycle_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_event_job" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_execution" (
	"payment_order_id" uuid PRIMARY KEY NOT NULL,
	"config_version" integer NOT NULL,
	"credential_key_id" varchar(160) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'ready' NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_code" varchar(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_execution_state_chk" CHECK ("payment_execution"."state" IN ('ready','dispatched','unknown','linked')),
	CONSTRAINT "payment_execution_test_key_chk" CHECK ("payment_execution"."credential_key_id" ~ '^rzp_test_[A-Za-z0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "booking_lifecycle_event" ADD CONSTRAINT "booking_lifecycle_event_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_event_job" ADD CONSTRAINT "payment_event_job_event_id_payment_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."payment_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_execution" ADD CONSTRAINT "payment_execution_payment_order_id_payment_order_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_execution" ADD CONSTRAINT "payment_execution_config_version_payment_gateway_config_version_fk" FOREIGN KEY ("config_version") REFERENCES "public"."payment_gateway_config"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_lifecycle_once_idx" ON "booking_lifecycle_event" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX "payment_event_job_due_idx" ON "payment_event_job" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "payment_execution_work_idx" ON "payment_execution" USING btree ("next_check_at");
--> statement-breakpoint
CREATE TRIGGER execution_immutable BEFORE UPDATE OR DELETE ON payment_execution FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','next_check_at','failure_code','updated_at');
--> statement-breakpoint
CREATE TRIGGER lifecycle_immutable BEFORE UPDATE OR DELETE ON booking_lifecycle_event FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE FUNCTION rentra_checkout_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment_order; c payment_gateway_config;
BEGIN
  SELECT * INTO STRICT p FROM payment_order WHERE id=NEW.payment_order_id;
  SELECT * INTO STRICT c FROM payment_gateway_config WHERE version=NEW.config_version;
  IF (p.provider,p.environment::text,p.mode::text,p.currency,p.purpose::text)
    IS DISTINCT FROM ('razorpay','test','real','INR',c.collection_purpose)
    OR NOT c.enabled OR c.provider<>'razorpay' OR c.environment<>'test'
    OR NEW.snapshot->>'provider'<>'razorpay' OR NEW.snapshot->>'environment'<>'test'
    OR (NEW.snapshot->>'version')::int IS DISTINCT FROM c.version
    OR (NEW.snapshot->>'expectedMinor')::bigint IS DISTINCT FROM p.expected_minor
    OR NEW.snapshot->>'collectionPurpose' IS DISTINCT FROM p.purpose::text
    OR NEW.snapshot->>'mode' IS DISTINCT FROM 'real'
    OR NEW.snapshot->>'enabled' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Checkout execution scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_scope BEFORE INSERT ON payment_execution FOR EACH ROW EXECUTE FUNCTION rentra_checkout_execution_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_checkout_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid; pinned boolean; mutable text[];
BEGIN
  IF TG_TABLE_NAME='booking_order' THEN
    parent_id=OLD.id;
    mutable=ARRAY['state','confirmed_at','updated_at'];
  ELSE
    parent_id=OLD.order_id;
    mutable=ARRAY['state','confirmed_at','cancelled_at','cancelled_by','cancellation_reason','updated_at','lifecycle_version','check_in_code','balance_settled_at'];
  END IF;
  SELECT EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=parent_id) INTO pinned;
  IF pinned AND (TG_OP='DELETE' OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable)) THEN
    RAISE EXCEPTION 'Accepted checkout terms are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER checkout_terms BEFORE UPDATE ON booking_order FOR EACH ROW EXECUTE FUNCTION rentra_checkout_terms_immutable();
--> statement-breakpoint
CREATE TRIGGER checkout_terms BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION rentra_checkout_terms_immutable();
