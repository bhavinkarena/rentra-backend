ALTER TABLE "listing_review" DROP CONSTRAINT "listing_review_rentable_id_rentable_id_fk";
--> statement-breakpoint
ALTER TABLE "review" DROP CONSTRAINT "review_rentable_id_rentable_id_fk";
--> statement-breakpoint
ALTER TABLE "verification_visit" DROP CONSTRAINT "verification_visit_rentable_id_rentable_id_fk";
--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "restricted_by" uuid;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "restriction_reason" text;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "lifecycle_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_review" ADD CONSTRAINT "listing_review_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentable" ADD CONSTRAINT "rentable_restricted_by_admin_user_id_fk" FOREIGN KEY ("restricted_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_visit" ADD CONSTRAINT "verification_visit_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- CP08: restriction bookkeeping is not content, and every status change bumps
-- lifecycle_version so admin hide/restore prepared against an older state fails.
-- A content change while hidden from pending_verification invalidates that
-- approval the same way it does for a visible property.
CREATE OR REPLACE FUNCTION version_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  excluded text[] := ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at','published_submission_id','published_at','published_by','restricted_at','restricted_by','restriction_reason','lifecycle_version'];
BEGIN
  IF (to_jsonb(NEW) - excluded) IS DISTINCT FROM (to_jsonb(OLD) - excluded) THEN
    NEW.content_version := OLD.content_version + 1;
  END IF;
  IF NEW.content_version <> OLD.content_version THEN
    IF OLD.status='pending_verification' THEN
      NEW.status := 'pending_review';
    ELSIF OLD.status='hidden' AND OLD.prior_status='pending_verification' THEN
      NEW.prior_status := 'pending_review';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.prior_status IS DISTINCT FROM OLD.prior_status
     OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at THEN
    NEW.lifecycle_version := OLD.lifecycle_version + 1;
  END IF;
  RETURN NEW;
END; $$;
