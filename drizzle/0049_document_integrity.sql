-- Phase 8 of docs/DATABASE-REVIEW.md: documents get real owner FKs and keep their review history.

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM document d WHERE d.owner_type NOT IN ('client_application', 'rentable')
    OR (d.owner_type = 'client_application' AND NOT EXISTS (SELECT 1 FROM client_application a WHERE a.id = d.owner_id))
    OR (d.owner_type = 'rentable' AND NOT EXISTS (SELECT 1 FROM rentable r WHERE r.id = d.owner_id));
  IF n > 0 THEN RAISE EXCEPTION '0049: % documents have an unknown or missing owner', n; END IF;
END $$;--> statement-breakpoint

-- Writers keep using owner_type/owner_id; generated columns give each owner kind a real FK
-- without rewriting rows (so document_content_version does not fire).
ALTER TABLE document
  ADD COLUMN application_id uuid GENERATED ALWAYS AS (CASE WHEN owner_type = 'client_application' THEN owner_id END) STORED,
  ADD COLUMN rentable_id uuid GENERATED ALWAYS AS (CASE WHEN owner_type = 'rentable' THEN owner_id END) STORED;--> statement-breakpoint
ALTER TABLE document
  ADD CONSTRAINT document_application_fk FOREIGN KEY (application_id) REFERENCES client_application(id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_rentable_fk FOREIGN KEY (rentable_id) REFERENCES rentable(id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_owner_chk CHECK (owner_type IN ('client_application', 'rentable') AND num_nonnulls(application_id, rentable_id) = 1);--> statement-breakpoint
CREATE INDEX document_application_idx ON document (application_id) WHERE application_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX document_rentable_idx ON document (rentable_id) WHERE rentable_id IS NOT NULL;--> statement-breakpoint

-- One LIVE file per slot. A re-upload supersedes the reviewed row instead of overwriting it.
DROP INDEX document_slot_idx;--> statement-breakpoint
CREATE UNIQUE INDEX document_live_slot_idx ON document (owner_type, owner_id, doc_type, side)
  WHERE status IN ('uploaded', 'accepted', 'rejected') AND deleted_at IS NULL;
