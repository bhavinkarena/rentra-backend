-- Story 5.4: report evidence photos and a structured report outcome.
CREATE TABLE "review_report_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL REFERENCES "review_report"("id") ON DELETE RESTRICT,
	"storage_key" text NOT NULL,
	"mime" varchar(32) NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_report_attachment_valid_chk" CHECK ("mime" IN ('image/jpeg','image/png','image/webp') AND "bytes" BETWEEN 1 AND 2097152)
);--> statement-breakpoint
CREATE UNIQUE INDEX "review_report_attachment_hash_idx" ON "review_report_attachment" ("report_id","sha256");--> statement-breakpoint
CREATE TRIGGER review_report_attachment_immutable BEFORE UPDATE OR DELETE ON review_report_attachment FOR EACH ROW EXECUTE FUNCTION rentra_financial_immutable();--> statement-breakpoint
ALTER TABLE "review_report" ADD COLUMN "outcome" varchar(16);--> statement-breakpoint
-- True only for rows whose outcome was inferred by this backfill, not decided by an admin.
ALTER TABLE "review_report" ADD COLUMN "outcome_inferred" boolean;--> statement-breakpoint
UPDATE review_report p SET outcome_inferred=true,outcome=CASE WHEN r.moderation_state IN ('hidden','rejected') THEN 'upheld' ELSE 'not_violation' END
  FROM review r WHERE r.id=p.review_id AND p.state='closed';--> statement-breakpoint
ALTER TABLE "review_report" ADD CONSTRAINT "review_report_outcome_chk" CHECK (("state"='open' AND "outcome" IS NULL) OR ("state"='closed' AND "outcome" IN ('upheld','not_violation')));
