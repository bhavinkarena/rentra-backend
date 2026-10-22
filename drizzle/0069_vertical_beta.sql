-- Hotel plan, Phase 9: closed beta. While a vertical is 'partners', guests whose phone is on this list
-- can see and book it after opening their invite link; everyone else (and every crawler) still sees nothing.
CREATE TABLE vertical_beta_guest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_code varchar(24) NOT NULL REFERENCES vertical(code) ON DELETE RESTRICT,
  phone varchar(10) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  note varchar(120),
  invited_by uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES admin_user(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX vertical_beta_guest_active_idx ON vertical_beta_guest (vertical_code, phone) WHERE revoked_at IS NULL;
