-- Story 1.3: a reviewer asks the owner for a property video tied to one submitted revision.
-- Status is derived: requested (no video), uploaded (video, not submitted), submitted.
CREATE TABLE property_evidence_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rentable_id uuid NOT NULL REFERENCES rentable(id),
  submission_id uuid NOT NULL REFERENCES listing_submission(id),
  content_version integer NOT NULL,
  kind text NOT NULL DEFAULT 'video' CHECK (kind = 'video'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  requested_by uuid NOT NULL REFERENCES admin_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  pending_public_id text,
  video_public_id text,
  video_format text CHECK (video_format IN ('mp4','mov')),
  video_bytes integer CHECK (video_bytes > 0 AND video_bytes <= 52428800),
  uploaded_at timestamptz,
  submitted_at timestamptz,
  CHECK (submitted_at IS NULL OR video_public_id IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX property_evidence_request_open_idx ON property_evidence_request(submission_id) WHERE submitted_at IS NULL;--> statement-breakpoint
CREATE INDEX property_evidence_request_rentable_idx ON property_evidence_request(rentable_id, requested_at DESC);--> statement-breakpoint
-- What a reviewer inspected can never change once the owner submitted it.
CREATE FUNCTION property_evidence_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'property evidence requests are never deleted'; END IF;
  IF OLD.submitted_at IS NOT NULL THEN RAISE EXCEPTION 'submitted property evidence is immutable'; END IF;
  IF (NEW.rentable_id, NEW.submission_id, NEW.content_version, NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.rentable_id, OLD.submission_id, OLD.content_version, OLD.reason, OLD.requested_by, OLD.requested_at)
  THEN RAISE EXCEPTION 'property evidence request scope is immutable'; END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER property_evidence_request_immutable BEFORE UPDATE OR DELETE ON property_evidence_request
  FOR EACH ROW EXECUTE FUNCTION property_evidence_request_immutable();
