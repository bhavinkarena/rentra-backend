CREATE TYPE "public"."availability_slot" AS ENUM('day', 'night');--> statement-breakpoint
CREATE TYPE "public"."balance_mode" AS ENUM('online_before', 'cash_on_arrival', 'none');--> statement-breakpoint
CREATE TYPE "public"."booking_slot" AS ENUM('day', 'night', 'full_day');--> statement-breakpoint
CREATE TYPE "public"."booking_state" AS ENUM('requested', 'confirmed', 'handed_over', 'returned', 'completed', 'cancelled', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."cancellation_tier" AS ENUM('flexible', 'moderate', 'strict');--> statement-breakpoint
CREATE TYPE "public"."client_type" AS ENUM('owner', 'authorised_agent');--> statement-breakpoint
CREATE TYPE "public"."fulfilment" AS ENUM('visit_site', 'pickup_from_owner', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('none', 'pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'pending_review', 'pending_verification', 'live', 'paused', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'processing', 'paid', 'failed', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."rentable_form" AS ENUM('fixed', 'movable');--> statement-breakpoint
CREATE TYPE "public"."rental_unit" AS ENUM('slot', 'night', 'day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'client');--> statement-breakpoint
CREATE TABLE "admin_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"name" varchar(160) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "area" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(120) NOT NULL,
	"centre" geometry(point)
);
--> statement-breakpoint
CREATE TABLE "availability" (
	"rentable_id" uuid NOT NULL,
	"day" date NOT NULL,
	"slot" "availability_slot" NOT NULL,
	"units_available" integer DEFAULT 1 NOT NULL,
	"price_override" integer,
	"blocked_by_client" boolean DEFAULT false NOT NULL,
	CONSTRAINT "availability_rentable_id_day_slot_pk" PRIMARY KEY("rentable_id","day","slot")
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(16) NOT NULL,
	"rentable_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"day" date NOT NULL,
	"slot" "booking_slot" NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"units_booked" integer DEFAULT 1 NOT NULL,
	"guests" integer DEFAULT 1 NOT NULL,
	"amount_rent" integer NOT NULL,
	"amount_fee" integer NOT NULL,
	"amount_deposit" integer DEFAULT 0 NOT NULL,
	"amount_advance_paid" integer DEFAULT 0 NOT NULL,
	"balance_mode" "balance_mode" DEFAULT 'online_before' NOT NULL,
	"balance_settled_at" timestamp with time zone,
	"state" "booking_state" DEFAULT 'requested' NOT NULL,
	"check_in_code" varchar(8),
	"contact_phone" varchar(15),
	"note" text,
	"accept_deadline" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" "user_role",
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(120) NOT NULL,
	"form" "rentable_form" DEFAULT 'fixed' NOT NULL,
	"default_rental_unit" "rental_unit" DEFAULT 'slot' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "category_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "city" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(120) NOT NULL,
	"state" varchar(80) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "city_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "client_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"phone" varchar(15) NOT NULL,
	"name" varchar(160),
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"gross" integer NOT NULL,
	"commission" integer NOT NULL,
	"tds_194o" integer DEFAULT 0 NOT NULL,
	"gst_tcs" integer DEFAULT 0 NOT NULL,
	"net" integer NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"utr" varchar(64),
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kyc_ref" varchar(128),
	"verified_name" varchar(160),
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_kyc_ref_unique" UNIQUE("kyc_ref")
);
--> statement-breakpoint
CREATE TABLE "redirect" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" varchar(512) NOT NULL,
	"to_path" varchar(512) NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirect_from_path_unique" UNIQUE("from_path")
);
--> statement-breakpoint
CREATE TABLE "rentable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"slug" varchar(140) NOT NULL,
	"title" varchar(140) NOT NULL,
	"description" text,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"form" "rentable_form" DEFAULT 'fixed' NOT NULL,
	"fulfilment" "fulfilment" DEFAULT 'visit_site' NOT NULL,
	"rental_unit" "rental_unit" DEFAULT 'slot' NOT NULL,
	"category_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"requires_operator" boolean DEFAULT false NOT NULL,
	"total_units" integer DEFAULT 1 NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"bedrooms" integer DEFAULT 0 NOT NULL,
	"highlight" varchar(60),
	"amenities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"house_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location" geometry(point),
	"exact_address" text,
	"deposit_amount" integer DEFAULT 0 NOT NULL,
	"cancellation_tier" "cancellation_tier" DEFAULT 'moderate' NOT NULL,
	"rating_avg" real,
	"review_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"availability_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rentable_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rentable_price" (
	"rentable_id" uuid NOT NULL,
	"slot" "booking_slot" NOT NULL,
	"weekday" integer NOT NULL,
	"weekend" integer NOT NULL,
	CONSTRAINT "rentable_price_rentable_id_slot_pk" PRIMARY KEY("rentable_id","slot")
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"rentable_id" uuid,
	"author_id" uuid NOT NULL,
	"author_role" "user_role" NOT NULL,
	"rating" integer NOT NULL,
	"cleanliness" integer,
	"accuracy" integer,
	"value_for_money" integer,
	"behaviour" integer,
	"body" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rentable_id" uuid NOT NULL,
	"serial_no" varchar(120),
	"condition_grade" varchar(24),
	"status" varchar(24) DEFAULT 'available' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(15) NOT NULL,
	"role" "user_role" NOT NULL,
	"name" varchar(160),
	"email" varchar(254),
	"person_id" uuid,
	"client_type" "client_type",
	"kyc_status" "kyc_status" DEFAULT 'none' NOT NULL,
	"payout_upi_id" varchar(128),
	"payout_bank_ref" varchar(128),
	"responds_within_mins" integer,
	"response_rate" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "area" ADD CONSTRAINT "area_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_staff" ADD CONSTRAINT "client_staff_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_area_id_area_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."area"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_verified_by_admin_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable_price" ADD CONSTRAINT "rentable_price_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "area_city_slug_idx" ON "area" USING btree ("city_id","slug");--> statement-breakpoint
CREATE INDEX "area_centre_idx" ON "area" USING gist ("centre");--> statement-breakpoint
CREATE INDEX "availability_day_idx" ON "availability" USING btree ("day","slot");--> statement-breakpoint
CREATE INDEX "booking_rentable_day_idx" ON "booking" USING btree ("rentable_id","day");--> statement-breakpoint
CREATE INDEX "booking_customer_idx" ON "booking" USING btree ("customer_id","state");--> statement-breakpoint
CREATE INDEX "booking_state_deadline_idx" ON "booking" USING btree ("state","accept_deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_client_phone_idx" ON "client_staff" USING btree ("client_id","phone");--> statement-breakpoint
CREATE INDEX "payout_client_status_idx" ON "payout" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "rentable_city_cat_idx" ON "rentable" USING btree ("city_id","category_id","status");--> statement-breakpoint
CREATE INDEX "rentable_area_idx" ON "rentable" USING btree ("area_id","status");--> statement-breakpoint
CREATE INDEX "rentable_client_idx" ON "rentable" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "rentable_location_idx" ON "rentable" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "review_booking_author_idx" ON "review" USING btree ("booking_id","author_id");--> statement-breakpoint
CREATE INDEX "unit_rentable_idx" ON "unit" USING btree ("rentable_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_phone_role_idx" ON "user" USING btree ("phone","role");--> statement-breakpoint
CREATE INDEX "user_person_idx" ON "user" USING btree ("person_id");