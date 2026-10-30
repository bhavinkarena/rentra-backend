-- Story 4.4: reviewed incident remedy decisions (deny, or a cumulative % target with responsibility).
-- A decision only records what Story 4.5 will execute: it never creates refunds, obligations or payouts.
-- One active decision per case; a new one supersedes the previous, history is kept.
-- Rollback: DROP TABLE incident_remedy_decision;
CREATE TABLE incident_remedy_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_request_id uuid NOT NULL REFERENCES support_request(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('deny','award')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  visit_ids uuid[] NOT NULL DEFAULT '{}',
  target_pct integer CHECK (target_pct BETWEEN 0 AND 100),
  responsibility text CHECK (responsibility IN ('proportional','owner_funded')),
  preview jsonb,
  digest text CHECK (digest ~ '^[a-f0-9]{64}$'),
  decided_by uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'decided' CHECK (state='decided'),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CHECK ((kind='deny' AND target_pct IS NULL AND responsibility IS NULL AND preview IS NULL AND digest IS NULL)
    OR (kind='award' AND target_pct IS NOT NULL AND responsibility IS NOT NULL AND preview IS NOT NULL AND digest IS NOT NULL AND cardinality(visit_ids)>0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX incident_remedy_decision_active ON incident_remedy_decision(support_request_id) WHERE superseded_at IS NULL;
