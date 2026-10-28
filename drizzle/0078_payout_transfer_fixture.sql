-- Isolated hypothetical Test operations: never funding, bank proceeds or recovery debt.
CREATE TABLE payout_transfer_fixture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL UNIQUE REFERENCES payment_allocation(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  destination_id uuid NOT NULL REFERENCES payout_destination(id) ON DELETE RESTRICT,
  destination_version integer NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto','manual')),
  policy jsonb NOT NULL,
  expected_minor bigint NOT NULL CHECK (expected_minor BETWEEN 1 AND 9007199254740991),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
  environment text NOT NULL DEFAULT 'test' CHECK (environment='test'),
  provider text NOT NULL CHECK (provider='local-fixture'),
  provider_account text NOT NULL CHECK (provider_account='local-fixture-account'),
  actor_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','processing','unknown','succeeded')),
  dispatched_at timestamptz,
  dispatch_actor_id uuid REFERENCES admin_user(id) ON DELETE RESTRICT,
  dispatch_mode text CHECK (dispatch_mode IN ('auto','manual')),
  dispatch_policy jsonb,
  consent_hash text CHECK (consent_hash ~ '^[a-f0-9]{64}$'),
  manual_consent boolean,
  evidence jsonb,
  evidence_hash text CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  actual_bank_minor bigint NOT NULL DEFAULT 0 CHECK (actual_bank_minor=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_key),
  CHECK ((state='reserved' AND dispatched_at IS NULL AND dispatch_actor_id IS NULL AND dispatch_mode IS NULL AND dispatch_policy IS NULL AND consent_hash IS NULL AND manual_consent IS NULL)
    OR (state<>'reserved' AND dispatched_at IS NOT NULL AND dispatch_actor_id IS NOT NULL AND dispatch_mode IS NOT NULL AND dispatch_policy IS NOT NULL
      AND (dispatch_mode='auto' OR (manual_consent IS TRUE AND consent_hash IS NOT NULL)))),
  CHECK ((state='succeeded')=(verified_at IS NOT NULL AND evidence_hash IS NOT NULL AND evidence IS NOT NULL)),
  CHECK (state<>'succeeded' OR evidence @> jsonb_build_object('operationId',id,'sourceId',source_id,'ownerId',owner_id,
    'destinationId',destination_id,'destinationVersion',destination_version,'expectedMinor',expected_minor::text,
    'currency',currency,'environment',environment,'provider',provider,'providerAccount',provider_account,'status','succeeded'))
);
--> statement-breakpoint
CREATE FUNCTION rentra_payout_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source payment_allocation; capture payment_transaction; visit booking; booked booking_order; dest payout_destination;
BEGIN
  IF current_database() !~ '^rentra_test_[a-z0-9_]+$' OR inet_server_addr() IS NULL
    OR inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet) THEN
    RAISE EXCEPTION 'Payout fixtures require an actual disposable localhost database' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fixture history is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','dispatched_at','dispatch_actor_id','dispatch_mode','dispatch_policy','consent_hash','manual_consent','evidence','evidence_hash','verified_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','dispatched_at','dispatch_actor_id','dispatch_mode','dispatch_policy','consent_hash','manual_consent','evidence','evidence_hash','verified_at'])
      OR (OLD.dispatched_at IS NOT NULL AND (NEW.dispatched_at,NEW.dispatch_actor_id,NEW.dispatch_mode,NEW.dispatch_policy,NEW.consent_hash,NEW.manual_consent)
        IS DISTINCT FROM (OLD.dispatched_at,OLD.dispatch_actor_id,OLD.dispatch_mode,OLD.dispatch_policy,OLD.consent_hash,OLD.manual_consent))
      OR (OLD.state='succeeded' AND NEW IS DISTINCT FROM OLD)
      OR (OLD.state<>'reserved' AND NEW.state='reserved') OR (OLD.state='unknown' AND NEW.state='processing') THEN
      RAISE EXCEPTION 'Fixture terms, dispatch claim and completed evidence are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state<>'reserved' OR NEW.dispatched_at IS NOT NULL THEN
    RAISE EXCEPTION 'Fixture must start reserved and undispatched' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT source FROM payment_allocation WHERE id=NEW.source_id;
  SELECT * INTO STRICT capture FROM payment_transaction WHERE id=source.transaction_id;
  SELECT * INTO STRICT visit FROM booking WHERE id=source.booking_id;
  SELECT * INTO STRICT booked FROM booking_order WHERE id=visit.order_id;
  SELECT * INTO STRICT dest FROM payout_destination WHERE id=NEW.destination_id;
  IF source.component::text<>'rent' OR capture.currency<>'INR' OR capture.mode::text<>'real' OR capture.environment::text<>'test'
    OR capture.kind::text<>'capture' OR capture.outcome::text<>'succeeded' OR capture.verified_at IS NULL
    OR booked.listing_snapshot->>'ownerId' IS DISTINCT FROM NEW.owner_id::text
    OR dest.client_id<>NEW.owner_id OR dest.version<>NEW.destination_version OR dest.state<>'verified'
    OR NOT rentra_payout_booking_supported(visit.id) OR rentra_payout_rent_capture_count(visit.id,'test')<>1
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE id=NEW.owner_id AND role='client' AND account_status='active')
    OR NEW.expected_minor<>source.actual_minor-coalesce((SELECT sum(ra.expected_minor) FROM refund_allocation ra
      JOIN refund r ON r.id=ra.refund_id WHERE ra.payment_allocation_id=source.id AND r.state::text<>'failed'),0) THEN
    RAISE EXCEPTION 'Fixture requires eligible verified Test rent and current destination' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payout_fixture_guard BEFORE INSERT OR UPDATE OR DELETE ON payout_transfer_fixture
  FOR EACH ROW EXECUTE FUNCTION rentra_payout_fixture_guard();
