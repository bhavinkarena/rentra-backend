-- Story 5.1: clean eligible reviews auto-publish (no admin pre-approval); published reviews stay public after the 30-day writing window.
-- Genuine stay, without the writing window: what keeps a published review public.
CREATE OR REPLACE FUNCTION rentra_review_genuine(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id
  WHERE b.id=visit AND b.customer_id=author AND b.rentable_id=listing AND r.client_id<>author
  AND b.order_id IS NOT NULL AND b.state='completed' AND b.visit_provenance='real' AND b.hours_known
  AND (b.slot::text='stay' OR (SELECT count(DISTINCT e.kind) FROM visit_evidence e WHERE e.booking_id=b.id AND e.nature='actual')=3))
$$;
--> statement-breakpoint
-- May write (or be (re)published): genuine and within 30 days of checkout.
CREATE OR REPLACE FUNCTION rentra_review_eligible(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rentra_review_genuine(visit,author,listing) AND EXISTS(SELECT 1 FROM booking b
  WHERE b.id=visit AND (b.ends_at IS NULL OR clock_timestamp() <= b.ends_at + interval '30 days'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.booking_id,NEW.rentable_id,NEW.author_id,NEW.author_role,NEW.rating,NEW.cleanliness,NEW.accuracy,NEW.value_for_money,NEW.body,NEW.staff,NEW.location,NEW.comfort,NEW.facilities,NEW.traveller_type)
    IS DISTINCT FROM (OLD.booking_id,OLD.rentable_id,OLD.author_id,OLD.author_role,OLD.rating,OLD.cleanliness,OLD.accuracy,OLD.value_for_money,OLD.body,OLD.staff,OLD.location,OLD.comfort,OLD.facilities,OLD.traveller_type) THEN
    RAISE EXCEPTION 'Submitted review content is immutable' USING ERRCODE='23514';
  END IF;
  -- Checks apply when a review is written or moves into published (or changes moderator);
  -- an already-published row may still change otherwise (owner reply), even after the window.
  IF NEW.moderation_state='published' OR TG_OP='INSERT' THEN
    IF TG_OP='INSERT' OR OLD.moderation_state<>'published' OR NEW.moderated_by IS DISTINCT FROM OLD.moderated_by THEN
      IF NEW.author_role='customer' AND NOT rentra_review_eligible(NEW.booking_id,NEW.author_id,NEW.rentable_id) THEN
        RAISE EXCEPTION 'Actual completed visit required' USING ERRCODE='23514';
      END IF;
      IF NEW.moderation_state='published' AND NOT (NEW.author_role='customer' AND (
          (NEW.moderated_by IS NOT NULL AND NEW.moderated_at IS NOT NULL AND EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.moderated_by AND is_active))
          -- Auto-publish: only submitReview inserts 'auto:clean', and only on insert.
          OR (TG_OP='INSERT' AND NEW.moderated_by IS NULL AND NEW.moderation_reason='auto:clean' AND NEW.published_at IS NOT NULL))) THEN
        RAISE EXCEPTION 'Active moderator required' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW public_customer_review AS
  SELECT r.* FROM review r WHERE r.author_role='customer' AND r.moderation_state='published' AND r.published_at IS NOT NULL
  AND rentra_review_genuine(r.booking_id,r.author_id,r.rentable_id);
