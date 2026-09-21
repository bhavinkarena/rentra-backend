CREATE TYPE "public"."payment_component" AS ENUM('rent', 'fee', 'tax', 'deposit');--> statement-breakpoint
CREATE TYPE "public"."payment_environment" AS ENUM('simulated', 'test', 'live');--> statement-breakpoint
CREATE TYPE "public"."payment_event_state" AS ENUM('received', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('advance', 'balance', 'deposit', 'full');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('created', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_transaction_kind" AS ENUM('simulated', 'authorization', 'capture', 'failure');--> statement-breakpoint
CREATE TYPE "public"."refund_state" AS ENUM('requested', 'processing', 'unknown', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "customer_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"provider_customer_id" varchar(160) NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"method_family" varchar(24) NOT NULL,
	"display_label" varchar(80) NOT NULL,
	"last4" varchar(4),
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_method_real_only_chk" CHECK ("customer_payment_method"."environment" IN ('test', 'live') AND "customer_payment_method"."provider" <> 'dummy'
    AND length(trim("customer_payment_method"."provider")) > 0 AND "customer_payment_method"."token_hash" ~ '^[a-f0-9]{64}$'
    AND length("customer_payment_method"."token_ciphertext") > 0 AND ("customer_payment_method"."last4" IS NULL OR "customer_payment_method"."last4" ~ '^[0-9]{4}$')
    AND (("customer_payment_method"."is_active" AND "customer_payment_method"."revoked_at" IS NULL) OR (NOT "customer_payment_method"."is_active" AND NOT "customer_payment_method"."is_default" AND "customer_payment_method"."revoked_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "payment_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"component" "payment_component" NOT NULL,
	"actual_minor" bigint DEFAULT 0 NOT NULL,
	"simulated_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocation_amount_chk" CHECK ("payment_allocation"."actual_minor" BETWEEN 0 AND 9007199254740991 AND "payment_allocation"."simulated_minor" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "payment_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_order_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider_payment_id" varchar(160),
	"method_id" uuid,
	"method_family" varchar(24),
	"expected_minor" bigint NOT NULL,
	"state" "payment_state" DEFAULT 'created' NOT NULL,
	"failure_code" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payment_attempt_scope_chk" CHECK ("payment_attempt"."currency" = 'INR'
  AND length(trim("payment_attempt"."provider")) > 0
  AND (("payment_attempt"."mode" = 'simulated' AND "payment_attempt"."provider" = 'dummy' AND "payment_attempt"."environment" = 'simulated')
    OR ("payment_attempt"."mode" = 'real' AND "payment_attempt"."provider" <> 'dummy' AND "payment_attempt"."environment" IN ('test', 'live')))),
	CONSTRAINT "payment_attempt_amount_chk" CHECK ("payment_attempt"."expected_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "payment_attempt_valid_chk" CHECK ("payment_attempt"."attempt_number" > 0 AND ("payment_attempt"."mode" <> 'simulated' OR ("payment_attempt"."method_id" IS NULL AND "payment_attempt"."method_family" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "payment_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"external_event_id" varchar(160) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"redacted_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_verified_at" timestamp with time zone NOT NULL,
	"state" "payment_event_state" DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(64),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_event_valid_chk" CHECK ("payment_event"."provider" <> 'dummy' AND length(trim("payment_event"."provider")) > 0
    AND "payment_event"."environment" IN ('test', 'live') AND length(trim("payment_event"."external_event_id")) > 0
    AND "payment_event"."attempts" >= 0 AND "payment_event"."payload_hash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("payment_event"."redacted_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "payment_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_order_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"expected_minor" bigint NOT NULL,
	"provider_order_id" varchar(160),
	"state" "payment_state" DEFAULT 'created' NOT NULL,
	"due_at" timestamp with time zone,
	"idempotency_key" varchar(160) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_order_scope_chk" CHECK ("payment_order"."currency" = 'INR'
  AND length(trim("payment_order"."provider")) > 0
  AND (("payment_order"."mode" = 'simulated' AND "payment_order"."provider" = 'dummy' AND "payment_order"."environment" = 'simulated')
    OR ("payment_order"."mode" = 'real' AND "payment_order"."provider" <> 'dummy' AND "payment_order"."environment" IN ('test', 'live')))),
	CONSTRAINT "payment_order_amount_chk" CHECK ("payment_order"."expected_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "payment_order_key_chk" CHECK (length(trim("payment_order"."idempotency_key")) > 0 AND "payment_order"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payment_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"reference" varchar(100) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider_payment_id" varchar(160),
	"external_ledger_id" varchar(160),
	"kind" "payment_transaction_kind" NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"expected_minor" bigint NOT NULL,
	"simulated_minor" bigint DEFAULT 0 NOT NULL,
	"authorized_minor" bigint DEFAULT 0 NOT NULL,
	"captured_minor" bigint DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"evidence_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transaction_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payment_transaction_scope_chk" CHECK ("payment_transaction"."currency" = 'INR'
  AND length(trim("payment_transaction"."provider")) > 0
  AND (("payment_transaction"."mode" = 'simulated' AND "payment_transaction"."provider" = 'dummy' AND "payment_transaction"."environment" = 'simulated')
    OR ("payment_transaction"."mode" = 'real' AND "payment_transaction"."provider" <> 'dummy' AND "payment_transaction"."environment" IN ('test', 'live')))),
	CONSTRAINT "payment_transaction_amount_chk" CHECK ("payment_transaction"."expected_minor" BETWEEN 0 AND 9007199254740991 AND "payment_transaction"."simulated_minor" BETWEEN 0 AND 9007199254740991 AND "payment_transaction"."authorized_minor" BETWEEN 0 AND 9007199254740991 AND "payment_transaction"."captured_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "payment_transaction_fact_chk" CHECK (
    ("payment_transaction"."mode" = 'simulated' AND "payment_transaction"."kind" = 'simulated' AND "payment_transaction"."outcome" = 'succeeded'
      AND left("payment_transaction"."reference", 10) = 'DUMMY_TXN_' AND "payment_transaction"."authorized_minor" = 0 AND "payment_transaction"."captured_minor" = 0
      AND "payment_transaction"."simulated_minor" = "payment_transaction"."expected_minor")
    OR ("payment_transaction"."mode" = 'real' AND "payment_transaction"."simulated_minor" = 0 AND "payment_transaction"."provider_payment_id" IS NOT NULL
      AND "payment_transaction"."external_ledger_id" IS NOT NULL AND "payment_transaction"."verified_at" IS NOT NULL AND "payment_transaction"."evidence_hash" ~ '^[a-f0-9]{64}$'
      AND "payment_transaction"."evidence_hash" IS NOT NULL AND (
        ("payment_transaction"."kind" = 'authorization' AND "payment_transaction"."outcome" = 'succeeded' AND "payment_transaction"."authorized_minor" > 0 AND "payment_transaction"."authorized_minor" <= "payment_transaction"."expected_minor" AND "payment_transaction"."captured_minor" = 0)
        OR ("payment_transaction"."kind" = 'capture' AND "payment_transaction"."outcome" = 'succeeded' AND "payment_transaction"."captured_minor" > 0 AND "payment_transaction"."captured_minor" <= "payment_transaction"."expected_minor" AND "payment_transaction"."authorized_minor" = 0)
        OR ("payment_transaction"."kind" = 'failure' AND "payment_transaction"."outcome" = 'failed' AND "payment_transaction"."captured_minor" = 0 AND "payment_transaction"."authorized_minor" = 0))))
);
--> statement-breakpoint
CREATE TABLE "refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"reference" varchar(100) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider_refund_id" varchar(160),
	"expected_minor" bigint NOT NULL,
	"actual_minor" bigint DEFAULT 0 NOT NULL,
	"reason" varchar(160) NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"state" "refund_state" DEFAULT 'requested' NOT NULL,
	"verified_at" timestamp with time zone,
	"evidence_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "refund_reference_unique" UNIQUE("reference"),
	CONSTRAINT "refund_scope_chk" CHECK ("refund"."currency" = 'INR'
  AND length(trim("refund"."provider")) > 0
  AND (("refund"."mode" = 'simulated' AND "refund"."provider" = 'dummy' AND "refund"."environment" = 'simulated')
    OR ("refund"."mode" = 'real' AND "refund"."provider" <> 'dummy' AND "refund"."environment" IN ('test', 'live')))),
	CONSTRAINT "refund_amount_chk" CHECK ("refund"."expected_minor" BETWEEN 0 AND 9007199254740991 AND "refund"."actual_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "refund_fact_chk" CHECK (length(trim("refund"."idempotency_key")) > 0 AND "refund"."request_hash" ~ '^[a-f0-9]{64}$'
    AND (("refund"."mode" = 'simulated' AND "refund"."actual_minor" = 0)
      OR ("refund"."mode" = 'real' AND (
        ("refund"."state" <> 'succeeded' AND "refund"."actual_minor" = 0)
        OR ("refund"."state" = 'succeeded' AND "refund"."actual_minor" = "refund"."expected_minor"
          AND "refund"."verified_at" IS NOT NULL AND "refund"."provider_refund_id" IS NOT NULL
          AND "refund"."evidence_hash" IS NOT NULL AND "refund"."evidence_hash" ~ '^[a-f0-9]{64}$')))))
);
--> statement-breakpoint
CREATE TABLE "refund_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"payment_allocation_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"component" "payment_component" NOT NULL,
	"expected_minor" bigint NOT NULL,
	"actual_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocation_amount_chk" CHECK ("refund_allocation"."expected_minor" BETWEEN 0 AND 9007199254740991 AND "refund_allocation"."actual_minor" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "refund_allocation_cap_chk" CHECK ("refund_allocation"."actual_minor" <= "refund_allocation"."expected_minor")
);
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "funding_allocation_id" uuid;--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "actual_net_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payment_method" ADD CONSTRAINT "customer_payment_method_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_transaction_id_payment_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_payment_order_id_payment_order_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_method_id_customer_payment_method_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."customer_payment_method"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_order" ADD CONSTRAINT "payment_order_booking_order_id_booking_order_id_fk" FOREIGN KEY ("booking_order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_transaction_id_payment_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation" ADD CONSTRAINT "refund_allocation_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation" ADD CONSTRAINT "refund_allocation_payment_allocation_id_payment_allocation_id_fk" FOREIGN KEY ("payment_allocation_id") REFERENCES "public"."payment_allocation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation" ADD CONSTRAINT "refund_allocation_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_token_idx" ON "customer_payment_method" USING btree ("provider","environment","token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_default_idx" ON "customer_payment_method" USING btree ("customer_id","provider","environment") WHERE "customer_payment_method"."is_active" AND "customer_payment_method"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_visit_component_idx" ON "payment_allocation" USING btree ("transaction_id","booking_id","component");--> statement-breakpoint
CREATE INDEX "payment_allocation_booking_idx" ON "payment_allocation" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_number_idx" ON "payment_attempt" USING btree ("payment_order_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_external_idx" ON "payment_attempt" USING btree ("provider","environment","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempt_active_idx" ON "payment_attempt" USING btree ("payment_order_id") WHERE "payment_attempt"."state" IN ('created', 'processing', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_event_external_idx" ON "payment_event" USING btree ("provider","environment","external_event_id");--> statement-breakpoint
CREATE INDEX "payment_event_work_idx" ON "payment_event" USING btree ("state","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_external_idx" ON "payment_order" USING btree ("provider","environment","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_key_idx" ON "payment_order" USING btree ("booking_order_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transaction_external_idx" ON "payment_transaction" USING btree ("provider","environment","external_ledger_id","kind");--> statement-breakpoint
CREATE INDEX "payment_transaction_attempt_idx" ON "payment_transaction" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_external_idx" ON "refund" USING btree ("provider","environment","provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_key_idx" ON "refund" USING btree ("transaction_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_source_idx" ON "refund_allocation" USING btree ("refund_id","payment_allocation_id");--> statement-breakpoint
CREATE INDEX "refund_allocation_source_lookup_idx" ON "refund_allocation" USING btree ("payment_allocation_id");--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_funding_allocation_id_payment_allocation_id_fk" FOREIGN KEY ("funding_allocation_id") REFERENCES "public"."payment_allocation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_funding_allocation_idx" ON "payout" USING btree ("funding_allocation_id");--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_actual_funding_chk" CHECK ("payout"."actual_net_minor" BETWEEN 0 AND 9007199254740991 AND ("payout"."actual_net_minor" = 0 OR "payout"."funding_allocation_id" IS NOT NULL));
--> statement-breakpoint
-- Custom triggers/views are reviewed migration DDL, not represented by Drizzle snapshots.
-- All financial writers lock/version the payment order before checking shared amounts.
-- A no-op UPDATE creates a row version: stale Repeatable Read snapshots abort instead of overspending.
CREATE FUNCTION rentra_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Financial history is append-only' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW) - coalesce(TG_ARGV,ARRAY[]::text[])) IS DISTINCT FROM (to_jsonb(OLD) - coalesce(TG_ARGV,ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'Financial identity, provenance and amounts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON payment_order FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','provider_order_id');
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON payment_attempt FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','provider_payment_id','failure_code','completed_at');
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON payment_transaction FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON payment_allocation FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON refund FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','actual_minor','provider_refund_id','verified_at','evidence_hash','completed_at');
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON refund_allocation FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('actual_minor');
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON payment_event FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','attempts','failure_code','processed_at');
--> statement-breakpoint
CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON customer_payment_method FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('is_active','is_default','revoked_at');
--> statement-breakpoint
CREATE FUNCTION rentra_financial_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po payment_order; bo booking_order; a payment_attempt; t payment_transaction;
  b booking; pa payment_allocation; r refund; m customer_payment_method;
BEGIN
  IF TG_TABLE_NAME = 'payment_order' THEN
    IF TG_OP='INSERT' THEN
      SELECT * INTO STRICT bo FROM booking_order WHERE id=NEW.booking_order_id FOR UPDATE;
    ELSE
      SELECT * INTO STRICT bo FROM booking_order WHERE id=NEW.booking_order_id;
    END IF;
    IF (bo.currency, bo.payment_mode) IS DISTINCT FROM (NEW.currency, NEW.mode) THEN
      RAISE EXCEPTION 'Payment order scope mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
      RAISE EXCEPTION 'Provider order identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_attempt' THEN
    UPDATE payment_order SET state=state WHERE id=NEW.payment_order_id RETURNING * INTO STRICT po;
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency,NEW.expected_minor)
      IS DISTINCT FROM (po.provider,po.environment,po.mode,po.currency,po.expected_minor) THEN
      RAISE EXCEPTION 'Attempt scope mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
      RAISE EXCEPTION 'Provider payment identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.method_id IS NOT NULL THEN
      SELECT * INTO STRICT m FROM customer_payment_method WHERE id=NEW.method_id;
      SELECT * INTO STRICT bo FROM booking_order WHERE id=po.booking_order_id;
      IF (m.customer_id,m.provider,m.environment) IS DISTINCT FROM (bo.customer_id,po.provider,po.environment) OR NOT m.is_active THEN
        RAISE EXCEPTION 'Payment method ownership/scope mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_transaction' THEN
    SELECT * INTO STRICT a FROM payment_attempt WHERE id=NEW.attempt_id;
    UPDATE payment_order SET state=state WHERE id=a.payment_order_id RETURNING * INTO STRICT po;
    -- Re-read after the lock: identity may have been assigned by the preceding writer.
    SELECT * INTO STRICT a FROM payment_attempt WHERE id=NEW.attempt_id;
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency,NEW.expected_minor,NEW.provider_payment_id)
      IS DISTINCT FROM (a.provider,a.environment,a.mode,a.currency,a.expected_minor,a.provider_payment_id) THEN
      RAISE EXCEPTION 'Transaction scope mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'payment_allocation' THEN
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'refund' THEN
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=NEW.transaction_id;
  ELSIF TG_TABLE_NAME = 'refund_allocation' THEN
    SELECT * INTO STRICT r FROM refund WHERE id=NEW.refund_id;
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=r.transaction_id;
  ELSIF TG_TABLE_NAME = 'payout' THEN
    IF TG_OP='UPDATE' AND OLD.funding_allocation_id IS NOT NULL AND
      (to_jsonb(NEW)-ARRAY['status','utr','settled_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','utr','settled_at']) THEN
      RAISE EXCEPTION 'Funded payout terms are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.funding_allocation_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO STRICT pa FROM payment_allocation WHERE id=NEW.funding_allocation_id;
    SELECT * INTO STRICT t FROM payment_transaction WHERE id=pa.transaction_id;
  END IF;
  SELECT * INTO STRICT a FROM payment_attempt WHERE id=t.attempt_id;
  UPDATE payment_order SET state=state WHERE id=a.payment_order_id RETURNING * INTO STRICT po;
  IF TG_TABLE_NAME = 'payment_allocation' THEN
    SELECT * INTO STRICT b FROM booking WHERE id=NEW.booking_id;
    IF b.order_id IS DISTINCT FROM po.booking_order_id OR b.payment_mode<>po.mode OR b.currency<>po.currency OR t.kind NOT IN ('capture','simulated')
      OR (t.mode='simulated' AND NEW.actual_minor<>0) OR (t.mode='real' AND NEW.simulated_minor<>0) THEN
      RAISE EXCEPTION 'Allocation source/visit mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'refund' THEN
    IF (NEW.provider,NEW.environment,NEW.mode,NEW.currency) IS DISTINCT FROM (t.provider,t.environment,t.mode,t.currency)
      OR t.kind NOT IN ('capture','simulated') THEN
      RAISE EXCEPTION 'Refund source mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND ((OLD.state='succeeded' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
      OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id)) THEN
      RAISE EXCEPTION 'Completed refund or provider identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'refund_allocation' THEN
    SELECT * INTO STRICT r FROM refund WHERE id=NEW.refund_id;
    SELECT * INTO STRICT pa FROM payment_allocation WHERE id=NEW.payment_allocation_id;
    IF (pa.transaction_id,pa.booking_id,pa.component) IS DISTINCT FROM (r.transaction_id,NEW.booking_id,NEW.component)
      OR (r.mode='simulated' AND NEW.actual_minor<>0) THEN
      RAISE EXCEPTION 'Refund allocation source mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND NEW.actual_minor < OLD.actual_minor THEN
      RAISE EXCEPTION 'Actual refund cannot be reversed' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'payout' THEN
    SELECT * INTO STRICT b FROM booking WHERE id=pa.booking_id;
    SELECT * INTO STRICT bo FROM booking_order WHERE id=po.booking_order_id;
    IF t.mode<>'real' OR t.environment<>'live' OR t.kind<>'capture' OR t.verified_at IS NULL
      OR pa.component<>'rent' OR b.visit_provenance<>'real' OR bo.visit_provenance<>'real'
      OR b.payment_mode<>'real' OR bo.payment_mode<>'real' OR b.state<>'completed'
      OR NEW.booking_id<>b.id OR NOT EXISTS (SELECT 1 FROM rentable WHERE id=b.rentable_id AND client_id=NEW.client_id) THEN
      RAISE EXCEPTION 'Payout requires eligible verified rent capture' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT OR UPDATE ON payment_order FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT OR UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT ON payment_transaction FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT ON payment_allocation FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT OR UPDATE ON refund FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT OR UPDATE ON refund_allocation FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE TRIGGER financial_scope BEFORE INSERT OR UPDATE ON payout FOR EACH ROW EXECUTE FUNCTION rentra_financial_scope();
--> statement-breakpoint
CREATE FUNCTION rentra_preserve_booking_payment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_payments boolean;
BEGIN
  IF TG_TABLE_NAME='booking_order' THEN
    SELECT EXISTS(SELECT 1 FROM payment_order WHERE booking_order_id=OLD.id) INTO has_payments;
  ELSE
    SELECT EXISTS(SELECT 1 FROM payment_order WHERE booking_order_id=OLD.order_id) INTO has_payments;
  END IF;
  IF has_payments AND
    (to_jsonb(NEW)->'payment_mode',to_jsonb(NEW)->'visit_provenance',NEW.customer_id,NEW.rentable_id,NEW.currency,NEW.time_zone,to_jsonb(NEW)->'order_id')
    IS DISTINCT FROM
    (to_jsonb(OLD)->'payment_mode',to_jsonb(OLD)->'visit_provenance',OLD.customer_id,OLD.rentable_id,OLD.currency,OLD.time_zone,to_jsonb(OLD)->'order_id') THEN
    RAISE EXCEPTION 'Booking payment scope/provenance is immutable once payment intent exists' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_scope_immutable BEFORE UPDATE ON booking_order FOR EACH ROW EXECUTE FUNCTION rentra_preserve_booking_payment_scope();
--> statement-breakpoint
CREATE TRIGGER payment_scope_immutable BEFORE UPDATE ON booking FOR EACH ROW EXECUTE FUNCTION rentra_preserve_booking_payment_scope();
--> statement-breakpoint
-- Deferred totals permit inserting a fact and its allocations atomically, never partially committing.
CREATE FUNCTION rentra_reconcile_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE poid uuid; tid uuid; po payment_order;
BEGIN
  IF TG_TABLE_NAME='payment_transaction' THEN tid:=NEW.id;
  ELSIF TG_TABLE_NAME IN ('payment_allocation','refund') THEN tid:=NEW.transaction_id;
  ELSIF TG_TABLE_NAME='refund_allocation' THEN SELECT transaction_id INTO tid FROM refund WHERE id=NEW.refund_id;
  ELSIF TG_TABLE_NAME='payout' THEN
    IF NEW.funding_allocation_id IS NULL THEN RETURN NULL; END IF;
    SELECT transaction_id INTO tid FROM payment_allocation WHERE id=NEW.funding_allocation_id;
  END IF;
  SELECT a.payment_order_id INTO poid FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id WHERE t.id=tid;
  SELECT * INTO STRICT po FROM payment_order WHERE id=poid FOR UPDATE;
  IF (SELECT coalesce(sum(t.captured_minor+t.simulated_minor),0) FROM payment_transaction t
      JOIN payment_attempt a ON a.id=t.attempt_id WHERE a.payment_order_id=poid) > po.expected_minor THEN
    RAISE EXCEPTION 'Successful collections exceed payment intent' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id
    WHERE a.payment_order_id=poid AND (
      t.captured_minor<>(SELECT coalesce(sum(x.actual_minor),0) FROM payment_allocation x WHERE x.transaction_id=t.id)
      OR t.simulated_minor<>(SELECT coalesce(sum(x.simulated_minor),0) FROM payment_allocation x WHERE x.transaction_id=t.id)
      OR (SELECT coalesce(sum(r.expected_minor),0) FROM refund r WHERE r.transaction_id=t.id AND r.state<>'failed') > t.captured_minor+t.simulated_minor)) THEN
    RAISE EXCEPTION 'Capture allocation or refund cap does not reconcile' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id
    JOIN payment_attempt a ON a.id=t.attempt_id WHERE a.payment_order_id=poid AND (
      r.expected_minor<>(SELECT coalesce(sum(x.expected_minor),0) FROM refund_allocation x WHERE x.refund_id=r.id)
      OR r.actual_minor<>(SELECT coalesce(sum(x.actual_minor),0) FROM refund_allocation x WHERE x.refund_id=r.id))) THEN
    RAISE EXCEPTION 'Refund allocation totals do not reconcile' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_allocation pa JOIN payment_transaction t ON t.id=pa.transaction_id
    JOIN payment_attempt a ON a.id=t.attempt_id WHERE a.payment_order_id=poid AND (
      (SELECT coalesce(sum(ra.expected_minor),0) FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
        WHERE ra.payment_allocation_id=pa.id AND r.state<>'failed')
      + (SELECT coalesce(sum(p.actual_net_minor),0) FROM payout p WHERE p.funding_allocation_id=pa.id AND p.status<>'failed')
      > pa.actual_minor+pa.simulated_minor)) THEN
    RAISE EXCEPTION 'Allocation refunds/payouts exceed available funds' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_reconciles AFTER INSERT ON payment_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rentra_reconcile_payment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_reconciles AFTER INSERT ON payment_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rentra_reconcile_payment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_reconciles AFTER INSERT OR UPDATE ON refund DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rentra_reconcile_payment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_reconciles AFTER INSERT OR UPDATE ON refund_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rentra_reconcile_payment();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_reconciles AFTER INSERT OR UPDATE ON payout DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rentra_reconcile_payment();
--> statement-breakpoint
-- Internal view only. Readers must filter customer/owner/admin authorization separately.
CREATE VIEW captured_payment_allocation AS
SELECT pa.id, pa.booking_id, pa.component, pa.actual_minor, b.customer_id,
  l.client_id, b.state AS booking_state,
  coalesce(r.refunded_minor,0) AS refunded_minor,
  coalesce(r.reserved_minor,0) AS refund_reserved_minor,
  coalesce(p.reserved_minor,0) AS payout_reserved_minor
FROM payment_allocation pa
JOIN payment_transaction t ON t.id=pa.transaction_id
JOIN payment_attempt a ON a.id=t.attempt_id
JOIN payment_order po ON po.id=a.payment_order_id
JOIN booking_order bo ON bo.id=po.booking_order_id
JOIN booking b ON b.id=pa.booking_id AND b.order_id=bo.id
JOIN rentable l ON l.id=b.rentable_id
LEFT JOIN LATERAL (
  SELECT sum(ra.actual_minor) FILTER (WHERE rf.state='succeeded') AS refunded_minor,
    sum(ra.expected_minor) FILTER (WHERE rf.state<>'failed') AS reserved_minor
  FROM refund_allocation ra JOIN refund rf ON rf.id=ra.refund_id WHERE ra.payment_allocation_id=pa.id
) r ON true
LEFT JOIN LATERAL (
  SELECT sum(actual_net_minor) FILTER (WHERE status<>'failed') AS reserved_minor
  FROM payout WHERE funding_allocation_id=pa.id
) p ON true
WHERE t.kind='capture' AND t.outcome='succeeded' AND t.mode='real'
  AND t.environment='live' AND t.verified_at IS NOT NULL
  AND bo.payment_mode='real' AND b.payment_mode='real'
  AND bo.visit_provenance='real' AND b.visit_provenance='real';
--> statement-breakpoint
CREATE FUNCTION rentra_preserve_funded_payout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.funding_allocation_id IS NOT NULL THEN
    RAISE EXCEPTION 'Funded payout history cannot be deleted' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER financial_history BEFORE DELETE ON payout FOR EACH ROW EXECUTE FUNCTION rentra_preserve_funded_payout();
