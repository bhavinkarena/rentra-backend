-- PROP-05: an owner pause may end on a date; the worker resumes it.
ALTER TABLE rentable ADD COLUMN paused_until date;
--> statement-breakpoint
-- The pause end date is lifecycle bookkeeping, not content: it must not restart a review.
CREATE OR REPLACE FUNCTION version_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  excluded text[] := ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at','published_submission_id','published_at','published_by','restricted_at','restricted_by','restriction_reason','lifecycle_version','paused_until'];
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
  -- A pause date only means something while paused.
  IF NEW.status <> 'paused' THEN NEW.paused_until := NULL; END IF;
  RETURN NEW;
END; $$;
