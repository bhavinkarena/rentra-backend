CREATE TABLE "booking_cancellation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_execution" (
	"refund_id" uuid PRIMARY KEY NOT NULL,
	"dispatched_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_code" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "booking_cancellation" ADD CONSTRAINT "booking_cancellation_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cancellation" ADD CONSTRAINT "booking_cancellation_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_execution" ADD CONSTRAINT "refund_execution_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_request_idx" ON "booking_cancellation" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "refund_execution_work_idx" ON "refund_execution" USING btree ("next_check_at");--> statement-breakpoint
CREATE TRIGGER cancellation_immutable BEFORE UPDATE OR DELETE ON booking_cancellation FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();
--> statement-breakpoint
CREATE TRIGGER refund_execution_immutable BEFORE UPDATE OR DELETE ON refund_execution FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('dispatched_at','next_check_at','failure_code');
--> statement-breakpoint
CREATE FUNCTION rentra_refund_dispatch_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE EXCEPTION 'Refund dispatch cannot be reset' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER refund_dispatch_once BEFORE UPDATE ON refund_execution FOR EACH ROW EXECUTE FUNCTION rentra_refund_dispatch_once();
