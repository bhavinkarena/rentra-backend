-- Phase 2 of docs/DATABASE-REVIEW.md: tables, columns and indexes with no runtime reader or writer.
DROP INDEX IF EXISTS booking_state_deadline_idx;--> statement-breakpoint
DROP INDEX IF EXISTS booking_backfill_idx;--> statement-breakpoint
DROP INDEX IF EXISTS user_person_idx;--> statement-breakpoint
ALTER TABLE booking DROP COLUMN accept_deadline,
  DROP COLUMN legacy_advance_reported_minor,
  DROP COLUMN backfill_version,
  DROP COLUMN backfilled_at;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN person_id;--> statement-breakpoint
ALTER TABLE client_application DROP COLUMN kyc_ref, DROP COLUMN kyc_verified_at;--> statement-breakpoint
ALTER TABLE rentable DROP COLUMN requires_operator;--> statement-breakpoint
DROP TABLE unit;--> statement-breakpoint
DROP TABLE person;
