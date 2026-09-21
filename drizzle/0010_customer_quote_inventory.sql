CREATE TABLE "booking_price_override" (
	"rentable_id" uuid NOT NULL,
	"day" date NOT NULL,
	"slot" "booking_slot" NOT NULL,
	"rent_minor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_price_override_rentable_id_day_slot_pk" PRIMARY KEY("rentable_id","day","slot"),
	CONSTRAINT "booking_price_override_amount_chk" CHECK ("booking_price_override"."rent_minor" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_config" (
	"version" integer PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"collection_purpose" varchar(16) DEFAULT 'full' NOT NULL,
	"changed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_config_valid_chk" CHECK ("payment_gateway_config"."version" > 0 AND "payment_gateway_config"."environment" = 'test'
    AND "payment_gateway_config"."provider" = 'razorpay' AND "payment_gateway_config"."collection_purpose" IN ('full', 'advance'))
);
--> statement-breakpoint
ALTER TABLE "booking_quote" ADD COLUMN "payment_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "booking_config" jsonb;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "booking_config_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "extra_guest_charge" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_price_override" ADD CONSTRAINT "booking_price_override_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_config" ADD CONSTRAINT "payment_gateway_config_changed_by_admin_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Preserve pinned gateway revisions for existing quotes and future attempts.
CREATE FUNCTION payment_gateway_config_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment gateway revisions are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_gateway_config_immutable
BEFORE UPDATE OR DELETE ON payment_gateway_config
FOR EACH ROW EXECUTE FUNCTION payment_gateway_config_immutable();
