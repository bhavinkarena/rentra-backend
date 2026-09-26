CREATE TABLE "client_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"event_key" varchar(160) NOT NULL,
	"category" varchar(16) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"action" varchar(64) NOT NULL,
	"rentable_id" uuid,
	"order_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "client_update_valid_chk" CHECK ("client_update"."category" IN ('account','property','booking','case') AND "client_update"."kind" IN ('action','info'))
);
--> statement-breakpoint
CREATE TABLE "client_update_preference" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"muted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_update" ADD CONSTRAINT "client_update_client_id_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update" ADD CONSTRAINT "client_update_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update" ADD CONSTRAINT "client_update_order_id_booking_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."booking_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_update_preference" ADD CONSTRAINT "client_update_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_update_event_idx" ON "client_update" USING btree ("client_id","event_key");--> statement-breakpoint
CREATE INDEX "client_update_client_idx" ON "client_update" USING btree ("client_id","created_at");--> statement-breakpoint
-- CP15: every client update is written by the transaction that caused it.
-- The unique (client_id, event_key) makes a replayed event a no-op. An
-- informational update in a category the client muted is stored already read;
-- required work ('action') is never muted. No historical backfill: only events
-- after this migration produce updates.
CREATE FUNCTION client_update_insert(p_client uuid, p_key text, p_category text, p_kind text, p_action text,
  p_rentable uuid, p_order uuid, p_detail jsonb, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO client_update(client_id, event_key, category, kind, action, rentable_id, order_id, detail, created_at, read_at)
  VALUES (p_client, p_key, p_category, p_kind, p_action, p_rentable, p_order, coalesce(p_detail, '{}'::jsonb), p_at,
    CASE WHEN p_kind = 'info' AND EXISTS (SELECT 1 FROM client_update_preference pr
      WHERE pr.user_id = p_client AND pr.muted ? p_category) THEN p_at END)
  ON CONFLICT (client_id, event_key) DO NOTHING;
END; $$;
--> statement-breakpoint
-- Rentra's decisions about the client's properties and application. Reasons are
-- copied only where the admin form says the reason is shown to the client;
-- verification findings, notes, assignment and operator identity never are.
CREATE FUNCTION client_update_from_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner uuid;
  target uuid;
BEGIN
  IF NEW.actor_type <> 'admin' OR NEW.entity_id IS NULL
     OR NEW.entity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  IF NEW.entity = 'rentable' AND NEW.action IN ('listing_review_decided', 'verification_scheduled',
      'verification_rescheduled', 'verification_cancelled', 'verification_recorded', 'listing_published',
      'listing_hidden', 'listing_restored', 'listing_corrected') THEN
    target := NEW.entity_id::uuid;
    SELECT client_id INTO owner FROM rentable WHERE id = target;
    IF owner IS NULL THEN RETURN NEW; END IF;
    PERFORM client_update_insert(owner, 'audit:' || NEW.id, 'property',
      CASE WHEN NEW.action = 'listing_hidden'
        OR (NEW.action = 'listing_review_decided' AND NEW.after->>'outcome' IN ('changes_requested', 'rejected'))
        OR (NEW.action = 'verification_recorded' AND NEW.after->>'outcome' = 'failed')
        THEN 'action' ELSE 'info' END,
      NEW.action, target, NULL,
      jsonb_strip_nulls(jsonb_build_object(
        'outcome', NEW.after->>'outcome',
        'mode', CASE WHEN NEW.action = 'verification_scheduled' THEN NEW.after->>'mode' END,
        'status', CASE WHEN NEW.action = 'listing_restored' THEN NEW.after->>'status' END,
        'fields', CASE WHEN NEW.action = 'listing_corrected' AND jsonb_typeof(NEW.after) = 'object'
          THEN (SELECT jsonb_agg(k) FROM jsonb_object_keys(NEW.after) k) END,
        'reason', CASE WHEN NEW.action IN ('listing_review_decided', 'listing_hidden', 'listing_corrected')
          THEN NEW.reason END)),
      NEW.at);
  ELSIF NEW.entity = 'client_application'
      AND NEW.action IN ('application_approved', 'application_more_info', 'application_rejected') THEN
    SELECT user_id INTO owner FROM client_application WHERE id = NEW.entity_id::uuid;
    IF owner IS NULL THEN RETURN NEW; END IF;
    PERFORM client_update_insert(owner, 'audit:' || NEW.id, 'account',
      CASE WHEN NEW.action = 'application_approved' THEN 'info' ELSE 'action' END,
      NEW.action, NULL, NULL, jsonb_strip_nulls(jsonb_build_object('reason', NEW.reason)), NEW.at);
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER audit_client_update AFTER INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION client_update_from_audit();
--> statement-breakpoint
-- A confirmed booking and cancelled visits on the client's property.
CREATE FUNCTION client_update_from_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o record;
BEGIN
  IF NEW.kind <> 'confirmed' AND NEW.kind !~ '^cancel_[a-f0-9]{32}$' THEN RETURN NEW; END IF;
  SELECT bo.id, bo.reference, bo.rentable_id, bo.visit_provenance, r.client_id,
    EXISTS (SELECT 1 FROM payment_order p WHERE p.booking_order_id = bo.id AND p.environment = 'test') AS test_payment
    INTO o FROM booking_order bo JOIN rentable r ON r.id = bo.rentable_id WHERE bo.id = NEW.order_id;
  IF o.client_id IS NULL THEN RETURN NEW; END IF;
  PERFORM client_update_insert(o.client_id, 'lifecycle:' || NEW.id, 'booking', 'info',
    CASE WHEN NEW.kind = 'confirmed' THEN 'booking_confirmed' ELSE 'visits_cancelled' END,
    o.rentable_id, o.id,
    jsonb_build_object('reference', o.reference,
      'simulation', (o.visit_provenance IS DISTINCT FROM 'real') OR o.test_payment),
    NEW.created_at);
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER lifecycle_client_update AFTER INSERT ON booking_lifecycle_event FOR EACH ROW EXECUTE FUNCTION client_update_from_lifecycle();
--> statement-breakpoint
-- Rentra's messages on a booking case that the owner is allowed to read.
CREATE FUNCTION client_update_from_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  IF NEW.audience NOT IN ('client', 'everyone') OR NEW.actor_kind = 'owner' THEN RETURN NEW; END IF;
  SELECT bc.reference, bc.order_id, bo.rentable_id, r.client_id INTO c
    FROM booking_case bc JOIN booking_order bo ON bo.id = bc.order_id JOIN rentable r ON r.id = bo.rentable_id
    WHERE bc.id = NEW.case_id;
  IF c.client_id IS NULL THEN RETURN NEW; END IF;
  PERFORM client_update_insert(c.client_id, 'case_update:' || NEW.id, 'case', 'info', 'case_' || NEW.kind,
    c.rentable_id, c.order_id,
    jsonb_build_object('reference', c.reference, 'kind', NEW.kind, 'body', left(NEW.body, 280)),
    NEW.created_at);
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER case_client_update AFTER INSERT ON booking_case_update FOR EACH ROW EXECUTE FUNCTION client_update_from_case();
