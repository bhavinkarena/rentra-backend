ALTER TABLE "user" ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT owner_notification_prefs_chk CHECK (jsonb_typeof(notification_prefs)='object');
--> statement-breakpoint
ALTER TABLE client_update DROP CONSTRAINT client_update_valid_chk;
--> statement-breakpoint
ALTER TABLE client_update ADD CONSTRAINT client_update_valid_chk CHECK (category IN ('account','property','booking','case','review','team') AND kind IN ('action','info'));
--> statement-breakpoint
CREATE TABLE owner_notification (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 update_id uuid NOT NULL REFERENCES client_update(id) ON DELETE RESTRICT,
 event_key text NOT NULL, event varchar(64) NOT NULL, category varchar(16) NOT NULL,
 channel varchar(16) NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 state varchar(16) NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, delivered_at timestamptz,
 failure_code varchar(64), provider_id text, provider_account text, recipient text, sender text,
 body_hash varchar(64), lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT owner_notification_valid_chk CHECK (channel IN ('mobile','email','whatsapp','sms') AND state IN ('pending','sending','accepted','delivered','retry','blocked','failed','unknown','suppressed') AND attempts>=0 AND jsonb_typeof(payload)='object'),
 CONSTRAINT owner_notification_event_idx UNIQUE(user_id,event_key,channel)
);
--> statement-breakpoint
CREATE INDEX owner_notification_due_idx ON owner_notification(next_attempt_at) WHERE state IN ('pending','retry','blocked','accepted','sending');
--> statement-breakpoint
CREATE FUNCTION owner_notification_from_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO owner_notification(user_id,update_id,event_key,event,category,channel,payload,next_attempt_at)
 SELECT NEW.client_id,NEW.id,NEW.event_key,NEW.action,NEW.category,c,
   jsonb_build_object('kind',NEW.kind,'detail',NEW.detail,'propertyId',NEW.rentable_id,'orderId',NEW.order_id),NEW.created_at
 FROM unnest(ARRAY['mobile','email']) c ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER owner_notification_update AFTER INSERT ON client_update FOR EACH ROW EXECUTE FUNCTION owner_notification_from_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_update_insert(p_client uuid,p_key text,p_category text,p_kind text,p_action text,p_rentable uuid,p_order uuid,p_detail jsonb,p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO client_update(client_id,event_key,category,kind,action,rentable_id,order_id,detail,created_at)
 VALUES(p_client,p_key,p_category,p_kind,p_action,p_rentable,p_order,coalesce(p_detail,'{}'::jsonb),p_at)
 ON CONFLICT(client_id,event_key) DO NOTHING;
END; $$;
--> statement-breakpoint
CREATE FUNCTION owner_communication_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; property uuid; booking_order_id uuid; detail jsonb; action text; kind text := 'info';
BEGIN
 IF TG_TABLE_NAME='review' THEN
  IF NEW.moderation_state<>'published' OR OLD.moderation_state='published' THEN RETURN NEW; END IF;
  SELECT client_id INTO owner FROM rentable WHERE id=NEW.rentable_id;
  property := NEW.rentable_id; action := 'review_published'; kind := 'action'; detail := jsonb_build_object('reviewId',NEW.id);
 ELSIF TG_TABLE_NAME='review_report' THEN
  IF NEW.state<>'closed' OR OLD.state='closed' THEN RETURN NEW; END IF;
  SELECT r.rentable_id,l.client_id INTO property,owner FROM review r JOIN rentable l ON l.id=r.rentable_id WHERE r.id=NEW.review_id;
  IF NEW.reporter_id<>owner THEN RETURN NEW; END IF;
  action := 'review_report_closed'; detail := jsonb_build_object('reviewId',NEW.review_id,'resolution',NEW.resolution);
 ELSIF TG_TABLE_NAME='dispute_case' THEN
  owner := NEW.owner_id; booking_order_id := NEW.order_id;
  IF TG_OP='INSERT' THEN action := 'dispute_opened';
  ELSIF NEW.state='resolved' AND OLD.state<>'resolved' THEN action := 'dispute_resolved';
  ELSIF NEW.requested_party='owner' AND (OLD.requested_party IS DISTINCT FROM NEW.requested_party OR OLD.response_due IS DISTINCT FROM NEW.response_due) THEN action := 'dispute_response_requested'; kind := 'action';
  ELSE RETURN NEW; END IF;
  detail := jsonb_build_object('disputeId',NEW.id,'due',NEW.response_due);
 ELSIF TG_TABLE_NAME='visit_evidence' THEN
  IF NEW.actor_kind<>'staff' THEN RETURN NEW; END IF;
  SELECT r.client_id,b.rentable_id,b.order_id INTO owner,property,booking_order_id FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE b.id=NEW.booking_id;
  action := 'caretaker_evidence'; detail := jsonb_build_object('visitId',NEW.booking_id,'kind',NEW.kind);
 ELSIF TG_TABLE_NAME='client_staff' THEN
  IF NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM staff_property sp JOIN booking b ON b.rentable_id=sp.rentable_id WHERE sp.staff_id=NEW.id AND b.state='handed_over') THEN RETURN NEW; END IF;
  owner := NEW.client_id; action := 'caretaker_revoked'; kind := 'action'; detail := jsonb_build_object('staffId',NEW.id);
 END IF;
 IF owner IS NOT NULL THEN
  PERFORM client_update_insert(owner,TG_TABLE_NAME||':'||NEW.id||':'||action||':'||coalesce(detail->>'due',''),
   CASE WHEN TG_TABLE_NAME IN ('review','review_report') THEN 'review' WHEN TG_TABLE_NAME IN ('client_staff','visit_evidence') THEN 'team' ELSE 'case' END,
   kind,action,property,booking_order_id,detail,now());
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER owner_review_event AFTER UPDATE ON review FOR EACH ROW EXECUTE FUNCTION owner_communication_events();
--> statement-breakpoint
CREATE TRIGGER owner_review_report_event AFTER UPDATE ON review_report FOR EACH ROW EXECUTE FUNCTION owner_communication_events();
--> statement-breakpoint
CREATE TRIGGER owner_dispute_event AFTER INSERT OR UPDATE ON dispute_case FOR EACH ROW EXECUTE FUNCTION owner_communication_events();
--> statement-breakpoint
CREATE TRIGGER owner_staff_evidence_event AFTER INSERT ON visit_evidence FOR EACH ROW EXECUTE FUNCTION owner_communication_events();
--> statement-breakpoint
CREATE TRIGGER owner_staff_revoked_event AFTER UPDATE ON client_staff FOR EACH ROW EXECUTE FUNCTION owner_communication_events();
--> statement-breakpoint
CREATE FUNCTION owner_update_needs_action(u client_update) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE
 WHEN u.action='review_published' THEN EXISTS(SELECT 1 FROM public_customer_review r JOIN rentable l ON l.id=r.rentable_id WHERE r.id::text=u.detail->>'reviewId' AND l.client_id=u.client_id AND r.owner_reply IS NULL)
 WHEN u.action='dispute_response_requested' THEN EXISTS(SELECT 1 FROM dispute_case d WHERE d.id::text=u.detail->>'disputeId' AND d.owner_id=u.client_id AND d.state='open' AND d.requested_party='owner')
 WHEN u.action='support_reply' THEN EXISTS(SELECT 1 FROM support_request s WHERE s.id::text=u.detail->>'supportId' AND s.client_id=u.client_id AND s.state='waiting_customer')
 WHEN u.action IN ('application_more_info','application_rejected') THEN EXISTS(SELECT 1 FROM client_application a WHERE a.user_id=u.client_id AND a.status IN ('more_info_needed','rejected'))
 WHEN u.action='payout_destination_failed' THEN NOT EXISTS(SELECT 1 FROM payout_destination d WHERE d.client_id=u.client_id AND d.state IN ('submitted','verified'))
 WHEN u.action='dates_running_out' THEN EXISTS(SELECT 1 FROM rentable r WHERE r.id=u.rentable_id AND r.client_id=u.client_id AND r.status='live' AND r.rental_unit::text<>'hour' AND coalesce((r.booking_config->>'autoOpen')::boolean,false)=false AND NOT EXISTS(SELECT 1 FROM availability rd WHERE rd.rentable_id=r.id AND rd.day>(now() AT TIME ZONE 'Asia/Kolkata')::date+7 AND rd.units_available>0))
 WHEN u.action='checkout_overdue' THEN EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE b.id::text=u.detail->>'visitId' AND r.client_id=u.client_id AND b.state='handed_over')
 WHEN u.action='caretaker_revoked' THEN EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=u.client_id AND b.state='handed_over' AND EXISTS(SELECT 1 FROM staff_property sp WHERE sp.rentable_id=r.id AND sp.staff_id::text=u.detail->>'staffId'))
 WHEN u.kind='action' AND u.rentable_id IS NOT NULL THEN EXISTS(SELECT 1 FROM rentable r WHERE r.id=u.rentable_id AND r.client_id=u.client_id AND r.status IN ('draft','rejected','hidden'))
 ELSE false END;
$$;

--> statement-breakpoint
ALTER TABLE support_request DROP CONSTRAINT support_request_valid_chk;
--> statement-breakpoint
ALTER TABLE support_request ADD CONSTRAINT support_request_valid_chk CHECK (
 category IN ('booking','change','cancellation','payment','privacy','other','verification','account','property','calendar','earnings')
 AND state IN ('open','in_progress','waiting_customer','resolved') AND version>=0
 AND length(trim(subject)) BETWEEN 5 AND 120 AND request_hash ~ '^[a-f0-9]{64}$'
 AND (client_id IS NOT NULL OR category NOT IN ('booking','change','cancellation','payment') OR order_id IS NOT NULL)
 AND (privacy_request_id IS NULL OR (category='privacy' AND order_id IS NULL))
 AND (client_id IS NOT NULL OR category NOT IN ('verification','account','property','calendar','earnings')));

--> statement-breakpoint
ALTER TABLE dispute_case ADD COLUMN claim_summary text CHECK(claim_summary IS NULL OR length(trim(claim_summary)) BETWEEN 10 AND 2000);

--> statement-breakpoint
ALTER TABLE auth_session ADD COLUMN device_label varchar(120) NOT NULL DEFAULT 'Browser session', ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE otp_challenge ALTER COLUMN purpose TYPE varchar(32);
--> statement-breakpoint
ALTER TABLE otp_challenge DROP CONSTRAINT otp_challenge_valid_chk;
--> statement-breakpoint
ALTER TABLE otp_challenge ADD CONSTRAINT otp_challenge_valid_chk CHECK (
 principal_kind IN ('customer','client','staff') AND channel IN ('sms','email')
 AND purpose IN ('login','verify_phone','phone_change','payout_confirm','owner_email_change','owner_phone_change') AND attempts>=0
 AND code_hash ~ '^[a-f0-9]{64}$' AND expires_at>created_at
 AND (browser_hash IS NULL OR browser_hash ~ '^[a-f0-9]{64}$')
 AND (purpose<>'phone_change' OR (principal_kind='customer' AND user_id IS NOT NULL AND session_id IS NOT NULL))
 AND (purpose NOT IN ('payout_confirm','owner_email_change','owner_phone_change') OR (principal_kind='client' AND user_id IS NOT NULL AND session_id IS NOT NULL)));

--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT user_customer_fields_chk;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_customer_fields_chk CHECK (role IN ('customer','client') OR (privacy_erasure_pending=false AND privacy_erased_at IS NULL));

--> statement-breakpoint
ALTER TABLE staff_invitation ADD COLUMN delivery_state varchar(16) NOT NULL DEFAULT 'not_sent' CHECK(delivery_state IN ('not_sent','sending','accepted','delivered','failed','unknown')), ADD COLUMN provider_id text;

--> statement-breakpoint
ALTER TABLE content_draft DROP CONSTRAINT content_draft_kind_chk;
--> statement-breakpoint
ALTER TABLE content_draft ADD CONSTRAINT content_draft_kind_chk CHECK(kind IN ('terms','privacy','cancellation','help','contact','owner_help'));
--> statement-breakpoint
ALTER TABLE content_publication DROP CONSTRAINT content_publication_kind_chk;
--> statement-breakpoint
ALTER TABLE content_publication ADD CONSTRAINT content_publication_kind_chk CHECK(kind IN ('terms','privacy','cancellation','help','contact','owner_help'));
--> statement-breakpoint
DROP TRIGGER dispute_case_immutable ON dispute_case;
--> statement-breakpoint
CREATE TRIGGER dispute_case_immutable BEFORE UPDATE OR DELETE ON dispute_case FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable('state','assignee_id','requested_party','response_due','claim_summary','outcome','resolution','resolved_by','resolved_at','version','updated_at');
