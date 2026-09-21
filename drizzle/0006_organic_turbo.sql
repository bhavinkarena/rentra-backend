CREATE TYPE "public"."document_side" AS ENUM('front', 'back', 'single');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('uploaded', 'accepted', 'rejected', 'superseded', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('pan_card', 'aadhaar_masked', 'passport', 'driving_licence', 'voter_id', 'electricity_bill', 'property_tax', 'extract_7_12', 'extract_8a', 'index_ii', 'sale_deed', 'na_order', 'authorisation_letter', 'noc');--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" uuid NOT NULL,
	"doc_type" "document_type" NOT NULL,
	"side" "document_side" DEFAULT 'single' NOT NULL,
	"storage_key" varchar(300) NOT NULL,
	"mime_type" varchar(80),
	"bytes" integer,
	"width" integer,
	"height" integer,
	"name_on_document" varchar(160),
	"name_match" varchar(16),
	"issued_at" date,
	"status" "document_status" DEFAULT 'uploaded' NOT NULL,
	"reviewed_by" uuid,
	"review_note" text,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_reviewed_by_admin_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_owner_idx" ON "document" USING btree ("owner_type","owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_slot_idx" ON "document" USING btree ("owner_type","owner_id","doc_type","side");