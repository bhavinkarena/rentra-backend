-- Story 2.18: Test-only owner repayment link. A Rentra record bound to a Razorpay Test order.
-- Only a verified captured payment on the link's own order reduces owner_recovery.recovered_minor.
-- Lets owner_repayment bind owner_id to the recovery's owner (composite FK below).
ALTER TABLE owner_recovery ADD CONSTRAINT owner_recovery_id_owner_key UNIQUE (id,owner_id);
--> statement-breakpoint
CREATE TABLE owner_repayment (
  id uuid PRIMARY KEY,
  recovery_id uuid NOT NULL REFERENCES owner_recovery(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  environment text NOT NULL DEFAULT 'test' CHECK (environment='test'),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','paid','replaced','needs_review')),
  provider_order_id text NOT NULL UNIQUE CHECK (provider_order_id ~ '^order_[A-Za-z0-9]+$'),
  provider_payment_id text UNIQUE CHECK (provider_payment_id ~ '^pay_[A-Za-z0-9]+$'),
  review_code text,
  -- Excess may exceed amount_minor: a wrong-amount capture is held whole for admin return.
  excess_minor bigint NOT NULL DEFAULT 0 CHECK (excess_minor BETWEEN 0 AND 9007199254740991),
  actor_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(actor_id,request_key),
  FOREIGN KEY (recovery_id,owner_id) REFERENCES owner_recovery(id,owner_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX owner_repayment_one_open ON owner_repayment(recovery_id) WHERE state='open';
--> statement-breakpoint
CREATE INDEX owner_repayment_recovery ON owner_repayment(recovery_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX owner_repayment_owner ON owner_repayment(owner_id,created_at DESC);
