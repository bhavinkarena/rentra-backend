-- Additive expansion only. Existing booking IDs, legacy columns, payouts and reviews remain intact.
CREATE TYPE "public"."booking_order_state" AS ENUM('draft', 'held', 'confirmed', 'partially_cancelled', 'completed', 'cancelled', 'expired', 'legacy');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('simulated', 'real', 'legacy_unknown');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('held', 'committed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."visit_provenance" AS ENUM('real', 'test', 'seed', 'legacy_unknown');--> statement-breakpoint
CREATE TABLE "booking_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(64) NOT NULL,
	"customer_id" uuid NOT NULL,
	"rentable_id" uuid NOT NULL,
	"state" "booking_order_state" DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"quote_id" uuid,
	"quote_version" integer,
	"quote_hash" varchar(64),
	"quote_expires_at" timestamp with time zone,
	"pricing_version" varchar(32) NOT NULL,
	"policy_version" varchar(32) NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"listing_snapshot" jsonb NOT NULL,
	"amount_rent_minor" bigint NOT NULL,
	"amount_fee_minor" bigint NOT NULL,
	"amount_deposit_minor" bigint NOT NULL,
	"amount_advance_minor" bigint,
	"collected_minor" bigint DEFAULT 0 NOT NULL,
	"payment_mode" "payment_mode" DEFAULT 'legacy_unknown' NOT NULL,
	"visit_provenance" "visit_provenance" DEFAULT 'legacy_unknown' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_order_reference_unique" UNIQUE("reference"),
	CONSTRAINT "booking_order_valid_chk" CHECK ("booking_order"."currency" = 'INR' AND "booking_order"."time_zone" = 'Asia/Kolkata'
    AND "booking_order"."amount_rent_minor" BETWEEN 0 AND 9007199254740991
    AND "booking_order"."amount_fee_minor" BETWEEN 0 AND 9007199254740991
    AND "booking_order"."amount_deposit_minor" BETWEEN 0 AND 9007199254740991
    AND ("booking_order"."amount_advance_minor" IS NULL OR "booking_order"."amount_advance_minor" BETWEEN 0 AND 9007199254740991)
    AND "booking_order"."collected_minor" BETWEEN 0 AND 9007199254740991
    AND ("booking_order"."collected_minor" = 0 OR "booking_order"."payment_mode" = 'real')
    AND ("booking_order"."state" <> 'held' OR "booking_order"."hold_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "booking_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"intent_hash" varchar(64),
	"rentable_id" uuid NOT NULL,
	"currency" varchar(3) NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"selection" jsonb NOT NULL,
	"visit_snapshots" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"pricing_version" varchar(32) NOT NULL,
	"policy_version" varchar(32) NOT NULL,
	"version" integer NOT NULL,
	"quote_hash" varchar(64) NOT NULL,
	"amount_rent_minor" bigint NOT NULL,
	"amount_fee_minor" bigint NOT NULL,
	"amount_deposit_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "booking_quote_valid_chk" CHECK ("booking_quote"."currency" = 'INR' AND "booking_quote"."time_zone" = 'Asia/Kolkata'
    AND "booking_quote"."version" > 0 AND "booking_quote"."expires_at" > "booking_quote"."created_at"
    AND "booking_quote"."amount_rent_minor" BETWEEN 0 AND 9007199254740991
    AND "booking_quote"."amount_fee_minor" BETWEEN 0 AND 9007199254740991
    AND "booking_quote"."amount_deposit_minor" BETWEEN 0 AND 9007199254740991
    AND jsonb_typeof("booking_quote"."selection") = 'object'
    AND jsonb_typeof("booking_quote"."visit_snapshots") = 'array'
    AND jsonb_array_length("booking_quote"."visit_snapshots") BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"rentable_id" uuid NOT NULL,
	"source" varchar(24) NOT NULL,
	"resource_key" varchar(64) DEFAULT 'property' NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"blocked_start_at" timestamp with time zone NOT NULL,
	"blocked_end_at" timestamp with time zone NOT NULL,
	"state" "reservation_state" NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_valid_chk" CHECK ("inventory_reservation"."blocked_end_at" > "inventory_reservation"."blocked_start_at"
    AND isfinite("inventory_reservation"."blocked_start_at") AND isfinite("inventory_reservation"."blocked_end_at")
    AND "inventory_reservation"."units" = 1 AND "inventory_reservation"."resource_key" = 'property'
    AND (("inventory_reservation"."source" = 'booking' AND "inventory_reservation"."booking_id" IS NOT NULL) OR ("inventory_reservation"."source" = 'owner_block' AND "inventory_reservation"."booking_id" IS NULL))
    AND ("inventory_reservation"."state" <> 'held' OR "inventory_reservation"."hold_expires_at" IS NOT NULL)
    AND (("inventory_reservation"."state" IN ('released', 'expired') AND "inventory_reservation"."released_at" IS NOT NULL)
      OR ("inventory_reservation"."state" IN ('held', 'committed') AND "inventory_reservation"."released_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "item_position" integer;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "local_day" date;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "time_zone" varchar(64);--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "currency" varchar(3);--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "blocked_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "blocked_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "hours_known" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "amount_rent_minor" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "amount_fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "amount_deposit_minor" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "amount_advance_minor" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "collected_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "payment_mode" "payment_mode" DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "visit_provenance" "visit_provenance" DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "policy_version" varchar(32);--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "pricing_version" varchar(32);--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "listing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "slot_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "price_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "legacy_advance_reported_minor" bigint;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "backfill_version" varchar(32);--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "backfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_order" ADD CONSTRAINT "booking_order_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_order" ADD CONSTRAINT "booking_order_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_order" ADD CONSTRAINT "booking_order_quote_id_booking_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."booking_quote"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_quote" ADD CONSTRAINT "booking_quote_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_quote" ADD CONSTRAINT "booking_quote_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Referenced composite key must exist before its foreign key.
CREATE UNIQUE INDEX "booking_id_rentable_idx" ON "booking" USING btree ("id","rentable_id");--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "reservation_booking_listing_fk" FOREIGN KEY ("booking_id","rentable_id") REFERENCES "public"."booking"("id","rentable_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_order_customer_key_idx" ON "booking_order" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_order_scope_idx" ON "booking_order" USING btree ("id","customer_id","rentable_id","currency","time_zone");--> statement-breakpoint
CREATE INDEX "booking_order_history_idx" ON "booking_order" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_order_hold_idx" ON "booking_order" USING btree ("state","hold_expires_at");--> statement-breakpoint
CREATE INDEX "booking_quote_expiry_idx" ON "booking_quote" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_active_booking_idx" ON "inventory_reservation" USING btree ("booking_id") WHERE "inventory_reservation"."state" IN ('held', 'committed');--> statement-breakpoint
CREATE INDEX "reservation_listing_state_idx" ON "inventory_reservation" USING btree ("rentable_id","state");--> statement-breakpoint
CREATE INDEX "reservation_expiry_idx" ON "inventory_reservation" USING btree ("state","hold_expires_at");--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_order_scope_fk" FOREIGN KEY ("order_id","customer_id","rentable_id","currency","time_zone") REFERENCES "public"."booking_order"("id","customer_id","rentable_id","currency","time_zone") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_order_idx" ON "booking" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "booking_backfill_idx" ON "booking" USING btree ("backfill_version");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_order_position_idx" ON "booking" USING btree ("order_id","item_position");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_order_localday_slot_idx" ON "booking" USING btree ("order_id","local_day","slot");--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_order_visit_chk" CHECK ("booking"."order_id" IS NULL OR (
      "booking"."item_position" IS NOT NULL AND "booking"."item_position" BETWEEN 1 AND 10
      AND "booking"."local_day" IS NOT NULL AND "booking"."currency" IS NOT NULL AND "booking"."time_zone" IS NOT NULL
      AND "booking"."guests" > 0 AND "booking"."units_booked" = 1
      AND "booking"."amount_rent_minor" IS NOT NULL AND "booking"."amount_fee_minor" IS NOT NULL AND "booking"."amount_deposit_minor" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_collected_requires_real_chk" CHECK ("booking"."collected_minor" = 0 OR "booking"."payment_mode" = 'real');--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_legacy_advance_chk" CHECK ("booking"."legacy_advance_reported_minor" IS NULL OR "booking"."legacy_advance_reported_minor" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_minor_amounts_nonnegative_chk" CHECK (("booking"."amount_rent_minor" IS NULL OR "booking"."amount_rent_minor" BETWEEN 0 AND 9007199254740991)
        AND ("booking"."amount_fee_minor" IS NULL OR "booking"."amount_fee_minor" BETWEEN 0 AND 9007199254740991)
        AND ("booking"."amount_deposit_minor" IS NULL OR "booking"."amount_deposit_minor" BETWEEN 0 AND 9007199254740991)
        AND ("booking"."amount_advance_minor" IS NULL OR "booking"."amount_advance_minor" BETWEEN 0 AND 9007199254740991)
        AND "booking"."collected_minor" BETWEEN 0 AND 9007199254740991);--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_known_hours_have_interval_chk" CHECK ("booking"."hours_known" = false OR (
        "booking"."starts_at" IS NOT NULL AND "booking"."ends_at" IS NOT NULL
        AND "booking"."blocked_start_at" IS NOT NULL AND "booking"."blocked_end_at" IS NOT NULL
        AND "booking"."ends_at" > "booking"."starts_at" AND "booking"."blocked_end_at" > "booking"."blocked_start_at"
        AND "booking"."blocked_start_at" <= "booking"."starts_at" AND "booking"."blocked_end_at" >= "booking"."ends_at"));
--> statement-breakpoint
-- Drizzle does not model exclusion constraints: preserve this custom DDL in future migrations.
-- This empty ledger is staged; Part 04 must remediate legacy intervals before switching authority.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "reservation_active_overlap_excl"
EXCLUDE USING gist ("rentable_id" WITH =, tstzrange("blocked_start_at", "blocked_end_at", '[)') WITH &&)
WHERE ("state" IN ('held', 'committed'));
