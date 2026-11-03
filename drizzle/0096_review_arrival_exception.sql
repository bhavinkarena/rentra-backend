-- Story 5.2: an admin-reviewed, case-linked exception lets a guest who arrived but could not stay
-- write one scoped review (overall stars + text). Cancelled/no-show alone never grants one.
CREATE TABLE review_eligibility_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_request_id uuid NOT NULL REFERENCES support_request(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES booking(id) ON DELETE RESTRICT,
  author_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  rentable_id uuid NOT NULL REFERENCES rentable(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved','denied')),
  scope text CHECK (scope IN ('arrival_access','arrival_early_stay')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  window_ends_at timestamptz NOT NULL,
  decided_by uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT review_eligibility_exception_scope_chk CHECK ((decision='approved') = (scope IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX review_eligibility_exception_active_idx ON review_eligibility_exception(booking_id,author_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX review_eligibility_exception_case_idx ON review_eligibility_exception(support_request_id);
--> statement-breakpoint
-- Append-only apart from revoke.
CREATE TRIGGER review_eligibility_exception_immutable BEFORE UPDATE OR DELETE ON review_eligibility_exception
  FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('revoked_at');
--> statement-breakpoint
-- Revoke happens once: revoked_at goes NULL -> value and never back.
CREATE FUNCTION rentra_review_exception_revoke_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'An exception is revoked once and never restored' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER review_eligibility_exception_revoke_once BEFORE UPDATE OF revoked_at ON review_eligibility_exception
  FOR EACH ROW EXECUTE FUNCTION rentra_review_exception_revoke_once();
--> statement-breakpoint
ALTER TABLE review ADD COLUMN experience_scope text;
--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_experience_scope_chk CHECK (experience_scope IS NULL OR (
  experience_scope IN ('arrival_access','arrival_early_stay') AND cleanliness IS NULL AND accuracy IS NULL AND value_for_money IS NULL
  AND behaviour IS NULL AND staff IS NULL AND location IS NULL AND comfort IS NULL AND facilities IS NULL AND traveller_type IS NULL));
--> statement-breakpoint
-- Active approved exception scope for a real, owned, ordered visit (no completed state required).
CREATE OR REPLACE FUNCTION rentra_review_exception_scope(visit uuid, author uuid, listing uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT x.scope FROM review_eligibility_exception x JOIN booking b ON b.id=x.booking_id JOIN rentable r ON r.id=b.rentable_id
  WHERE x.booking_id=visit AND x.author_id=author AND x.rentable_id=listing AND x.decision='approved' AND x.revoked_at IS NULL
  AND b.customer_id=author AND b.rentable_id=listing AND r.client_id<>author AND b.order_id IS NOT NULL AND b.visit_provenance='real'
$$;
--> statement-breakpoint
-- The 5.1 completed-stay core, unchanged.
CREATE OR REPLACE FUNCTION rentra_review_completed(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id
  WHERE b.id=visit AND b.customer_id=author AND b.rentable_id=listing AND r.client_id<>author
  AND b.order_id IS NOT NULL AND b.state='completed' AND b.visit_provenance='real' AND b.hours_known
  AND (b.slot::text='stay' OR (SELECT count(DISTINCT e.kind) FROM visit_evidence e WHERE e.booking_id=b.id AND e.nature='actual')=3))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_genuine(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rentra_review_completed(visit,author,listing) OR rentra_review_exception_scope(visit,author,listing) IS NOT NULL
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_eligible(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (rentra_review_completed(visit,author,listing) AND EXISTS(SELECT 1 FROM booking b
    WHERE b.id=visit AND (b.ends_at IS NULL OR clock_timestamp() <= b.ends_at + interval '30 days')))
  OR (rentra_review_exception_scope(visit,author,listing) IS NOT NULL AND EXISTS(SELECT 1 FROM review_eligibility_exception x
    WHERE x.booking_id=visit AND x.author_id=author AND x.decision='approved' AND x.revoked_at IS NULL AND clock_timestamp() <= x.window_ends_at))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rentra_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.booking_id,NEW.rentable_id,NEW.author_id,NEW.author_role,NEW.rating,NEW.cleanliness,NEW.accuracy,NEW.value_for_money,NEW.body,NEW.staff,NEW.location,NEW.comfort,NEW.facilities,NEW.traveller_type,NEW.experience_scope)
    IS DISTINCT FROM (OLD.booking_id,OLD.rentable_id,OLD.author_id,OLD.author_role,OLD.rating,OLD.cleanliness,OLD.accuracy,OLD.value_for_money,OLD.body,OLD.staff,OLD.location,OLD.comfort,OLD.facilities,OLD.traveller_type,OLD.experience_scope) THEN
    RAISE EXCEPTION 'Submitted review content is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.moderation_state='published' OR TG_OP='INSERT' THEN
    IF TG_OP='INSERT' OR OLD.moderation_state<>'published' OR NEW.moderated_by IS DISTINCT FROM OLD.moderated_by THEN
      -- Writing needs the window; a moderator publishing a flagged scoped review later needs only genuine.
      IF NEW.author_role='customer' AND NOT (CASE WHEN TG_OP='UPDATE' AND NEW.experience_scope IS NOT NULL
          THEN rentra_review_genuine(NEW.booking_id,NEW.author_id,NEW.rentable_id)
          ELSE rentra_review_eligible(NEW.booking_id,NEW.author_id,NEW.rentable_id) END) THEN
        RAISE EXCEPTION 'Actual completed visit required' USING ERRCODE='23514';
      END IF;
      -- Story 5.2: a review on an exception carries exactly its scope; a normal review carries none.
      IF NEW.author_role='customer' AND NEW.experience_scope IS DISTINCT FROM
          (CASE WHEN rentra_review_completed(NEW.booking_id,NEW.author_id,NEW.rentable_id) THEN NULL
            ELSE rentra_review_exception_scope(NEW.booking_id,NEW.author_id,NEW.rentable_id) END) THEN
        RAISE EXCEPTION 'Review scope must match the eligibility exception' USING ERRCODE='23514';
      END IF;
      IF NEW.moderation_state='published' AND NOT (NEW.author_role='customer' AND (
          (NEW.moderated_by IS NOT NULL AND NEW.moderated_at IS NOT NULL AND EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.moderated_by AND is_active))
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
