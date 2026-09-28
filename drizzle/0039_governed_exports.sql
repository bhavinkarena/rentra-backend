CREATE TABLE "admin_export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"dataset" varchar(32) NOT NULL,
	"scope" jsonb NOT NULL,
	"reason" text NOT NULL,
	"state" varchar(16) DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"artifact_ciphertext" text,
	"receipt" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_export_state_chk" CHECK ("admin_export_job"."state" IN ('queued','failed','completed') AND "admin_export_job"."version">0 AND "admin_export_job"."attempts">=0 AND "admin_export_job"."dataset" IN ('audit_events','payment_orders','operation_receipts'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_export_job" ADD CONSTRAINT "admin_export_job_creator_id_admin_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_export_request_idx" ON "admin_export_job" USING btree ("creator_id","request_key");--> statement-breakpoint
CREATE INDEX "admin_export_work_idx" ON "admin_export_job" USING btree ("state","updated_at");
--> statement-breakpoint
CREATE FUNCTION reject_audit_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit history is append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_history_append_only BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_history_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_history_no_truncate BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_history_mutation();
