-- Story 2.15 (FR-6): an owner's "pause and cancel upcoming stays" command, kept once per request key.
-- planned is fixed when the command is claimed; each booking's outcome is appended to results in the
-- same transaction that changes it, so a repeated submit finishes the unrecorded bookings and never
-- acts twice on a recorded one.
CREATE TABLE owner_cancel_upcoming (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES "user"(id),
  rentable_id uuid NOT NULL REFERENCES rentable(id),
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  planned jsonb NOT NULL DEFAULT '[]'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, request_key)
);--> statement-breakpoint
CREATE INDEX owner_cancel_upcoming_rentable_idx ON owner_cancel_upcoming(rentable_id, created_at DESC);
