-- Story 4.2: urgent stay issues alert support admins through admin_alert; first human reply is tracked
-- separately from resolution. Additive: existing alerts keep their rentable; stay_issue types live in
-- context jsonb (no CHECK), so `stranded` needs no schema change.
ALTER TABLE "admin_alert" DROP CONSTRAINT "admin_alert_kind_check";--> statement-breakpoint
ALTER TABLE "admin_alert" ADD CONSTRAINT "admin_alert_kind_check" CHECK ("kind" IN ('property_resubmitted','correction_unanswered','support_urgent','support_unanswered'));--> statement-breakpoint
ALTER TABLE "admin_alert" ALTER COLUMN "rentable_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_alert" ADD COLUMN "support_request_id" uuid REFERENCES "support_request"("id");--> statement-breakpoint
ALTER TABLE "admin_alert" ADD CONSTRAINT "admin_alert_subject_chk" CHECK ("rentable_id" IS NOT NULL OR "support_request_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "admin_alert_support_idx" ON "admin_alert"("support_request_id") WHERE "support_request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "first_response_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER support_request_terms_immutable ON support_request;--> statement-breakpoint
-- Backfill before the trigger returns, so the first milestone run does not alert historic replied cases.
UPDATE support_request r SET first_response_at=m.at
  FROM (SELECT request_id, min(created_at) at FROM support_message WHERE actor_kind='admin' AND NOT internal GROUP BY request_id) m
  WHERE m.request_id=r.id AND r.first_response_at IS NULL;--> statement-breakpoint
CREATE TRIGGER support_request_terms_immutable BEFORE UPDATE OR DELETE ON support_request FOR EACH ROW
EXECUTE FUNCTION rentra_financial_immutable('state','version','updated_at','assigned_to','priority','related_request_id','first_response_at');
