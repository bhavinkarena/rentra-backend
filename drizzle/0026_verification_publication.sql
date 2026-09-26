ALTER TABLE "rentable" ADD COLUMN "published_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "time_zone" varchar(64) DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_published_by_admin_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_submission_id_listing_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."listing_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_created_by_admin_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_recorded_by_admin_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Legacy data: keep only the newest open visit per property before enforcing one open visit.
UPDATE "verification_visit" v SET "cancelled_at"=now(), "cancel_reason"='Superseded before verification workflow (CP07 migration)'
WHERE v."completed_at" IS NULL AND v."cancelled_at" IS NULL AND EXISTS (
  SELECT 1 FROM "verification_visit" newer WHERE newer."rentable_id"=v."rentable_id"
    AND newer."completed_at" IS NULL AND newer."cancelled_at" IS NULL
    AND (newer."created_at", newer."id") > (v."created_at", v."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "verification_open_idx" ON "verification_visit" USING btree ("rentable_id") WHERE "verification_visit"."completed_at" IS NULL AND "verification_visit"."cancelled_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_published_submission_id_listing_submission_id_fk" FOREIGN KEY ("published_submission_id") REFERENCES "public"."listing_submission"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Publication bookkeeping (CP07) is not a content change: publishing must not mark the
-- reviewed revision stale. Same function as 0025 with the publication columns excluded.
CREATE OR REPLACE FUNCTION version_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at','published_submission_id','published_at','published_by'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at','published_submission_id','published_at','published_by']) THEN
    NEW.content_version := OLD.content_version + 1;
  END IF;
  IF NEW.content_version <> OLD.content_version AND OLD.status='pending_verification' THEN
    NEW.status := 'pending_review';
  END IF;
  RETURN NEW;
END; $$;
