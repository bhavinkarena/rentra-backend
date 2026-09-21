CREATE TYPE "public"."amenity_value_type" AS ENUM('none', 'count', 'dimensions', 'area', 'charge');--> statement-breakpoint
CREATE TYPE "public"."listing_review_outcome" AS ENUM('changes_requested', 'approved_for_visit', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."visit_mode" AS ENUM('video_call', 'physical');--> statement-breakpoint
CREATE TYPE "public"."visit_outcome" AS ENUM('passed', 'failed', 'no_show');--> statement-breakpoint
ALTER TYPE "public"."listing_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "amenity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(60) NOT NULL,
	"group_slug" varchar(40) NOT NULL,
	"label_en" varchar(80) NOT NULL,
	"label_hi" varchar(120),
	"label_gu" varchar(120),
	"value_type" "amenity_value_type" DEFAULT 'none' NOT NULL,
	"is_filterable" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "amenity_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "listing_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rentable_id" uuid NOT NULL,
	"pass_number" integer DEFAULT 1 NOT NULL,
	"checklist" jsonb,
	"outcome" "listing_review_outcome" NOT NULL,
	"reason" text,
	"flagged_fields" jsonb,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rentable_amenity" (
	"rentable_id" uuid NOT NULL,
	"amenity_id" uuid NOT NULL,
	"value" varchar(40),
	CONSTRAINT "rentable_amenity_rentable_id_amenity_id_pk" PRIMARY KEY("rentable_id","amenity_id")
);
--> statement-breakpoint
CREATE TABLE "verification_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rentable_id" uuid NOT NULL,
	"mode" "visit_mode" DEFAULT 'video_call' NOT NULL,
	"assigned_to" uuid,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"geo_lat" real,
	"geo_lng" real,
	"report" jsonb,
	"outcome" "visit_outcome",
	"recording_key" varchar(300),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "prior_status" "listing_status";--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "approved_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "review_pass" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_review" ADD CONSTRAINT "listing_review_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_review" ADD CONSTRAINT "listing_review_reviewed_by_admin_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable_amenity" ADD CONSTRAINT "rentable_amenity_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable_amenity" ADD CONSTRAINT "rentable_amenity_amenity_id_amenity_id_fk" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_assigned_to_admin_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amenity_group_idx" ON "amenity" USING btree ("group_slug","sort_order");--> statement-breakpoint
CREATE INDEX "listing_review_idx" ON "listing_review" USING btree ("rentable_id","pass_number");--> statement-breakpoint
CREATE INDEX "visit_rentable_idx" ON "verification_visit" USING btree ("rentable_id","outcome");