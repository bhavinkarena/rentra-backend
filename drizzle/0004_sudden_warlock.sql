CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'more_info_needed', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "client_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"legal_name" varchar(160),
	"residential_address" text,
	"pincode" varchar(6),
	"intended_listing_count" integer,
	"owner_name" varchar(160),
	"owner_relationship" varchar(80),
	"kyc_ref" varchar(128),
	"kyc_doc_type" varchar(16),
	"kyc_name_on_doc" varchar(160),
	"kyc_verified_at" timestamp with time zone,
	"payout_upi_id" varchar(128),
	"payout_account_ref" varchar(64),
	"payout_ifsc" varchar(11),
	"payout_holder_name" varchar(160),
	"payout_name_match" boolean,
	"consent_at" timestamp with time zone,
	"consent_ip" varchar(45),
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"decision_reason" text,
	"flagged_fields" jsonb,
	"strike_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_application_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "client_application" ADD CONSTRAINT "client_application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_application" ADD CONSTRAINT "client_application_reviewed_by_admin_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_status_idx" ON "client_application" USING btree ("status","submitted_at");