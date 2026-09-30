-- Phase 7 of docs/DATABASE-REVIEW.md: every stored amount is integer paise in a *_minor column.
-- ALTER ... TYPE rewrites values without firing row triggers, so listing content versions
-- and frozen payout terms are untouched. API responses keep their rupee fields.

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM payout WHERE gross < 0 OR commission < 0 OR tds_194o < 0 OR gst_tcs < 0 OR net < 0;
  IF n > 0 THEN RAISE EXCEPTION '0048: % payouts have negative amounts; fix them first', n; END IF;
END $$;--> statement-breakpoint

ALTER TABLE rentable_price ALTER COLUMN weekday TYPE bigint USING weekday::bigint * 100;--> statement-breakpoint
ALTER TABLE rentable_price ALTER COLUMN weekend TYPE bigint USING weekend::bigint * 100;--> statement-breakpoint
ALTER TABLE rentable_price RENAME COLUMN weekday TO weekday_minor;--> statement-breakpoint
ALTER TABLE rentable_price RENAME COLUMN weekend TO weekend_minor;--> statement-breakpoint
ALTER TABLE rentable_price ADD CONSTRAINT rentable_price_amount_chk
  CHECK (weekday_minor BETWEEN 0 AND 9007199254740991 AND weekend_minor BETWEEN 0 AND 9007199254740991);--> statement-breakpoint

ALTER TABLE rentable ALTER COLUMN deposit_amount DROP DEFAULT;--> statement-breakpoint
ALTER TABLE rentable ALTER COLUMN deposit_amount TYPE bigint USING deposit_amount::bigint * 100;--> statement-breakpoint
ALTER TABLE rentable ALTER COLUMN deposit_amount SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE rentable RENAME COLUMN deposit_amount TO deposit_minor;--> statement-breakpoint
ALTER TABLE rentable ALTER COLUMN extra_guest_charge DROP DEFAULT;--> statement-breakpoint
ALTER TABLE rentable ALTER COLUMN extra_guest_charge TYPE bigint USING extra_guest_charge::bigint * 100;--> statement-breakpoint
ALTER TABLE rentable ALTER COLUMN extra_guest_charge SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE rentable RENAME COLUMN extra_guest_charge TO extra_guest_charge_minor;--> statement-breakpoint
ALTER TABLE rentable ADD CONSTRAINT rentable_money_chk
  CHECK (deposit_minor BETWEEN 0 AND 9007199254740991 AND extra_guest_charge_minor BETWEEN 0 AND 9007199254740991);--> statement-breakpoint

ALTER TABLE payout ALTER COLUMN gross TYPE bigint USING gross::bigint * 100;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN commission TYPE bigint USING commission::bigint * 100;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN tds_194o DROP DEFAULT;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN tds_194o TYPE bigint USING tds_194o::bigint * 100;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN tds_194o SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN gst_tcs DROP DEFAULT;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN gst_tcs TYPE bigint USING gst_tcs::bigint * 100;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN gst_tcs SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE payout ALTER COLUMN net TYPE bigint USING net::bigint * 100;--> statement-breakpoint
ALTER TABLE payout RENAME COLUMN gross TO gross_minor;--> statement-breakpoint
ALTER TABLE payout RENAME COLUMN commission TO commission_minor;--> statement-breakpoint
ALTER TABLE payout RENAME COLUMN tds_194o TO tds_194o_minor;--> statement-breakpoint
ALTER TABLE payout RENAME COLUMN gst_tcs TO gst_tcs_minor;--> statement-breakpoint
ALTER TABLE payout RENAME COLUMN net TO net_minor;--> statement-breakpoint
ALTER TABLE payout ADD CONSTRAINT payout_amounts_chk
  CHECK (gross_minor BETWEEN 0 AND 9007199254740991 AND commission_minor >= 0
    AND tds_194o_minor >= 0 AND gst_tcs_minor >= 0 AND net_minor BETWEEN 0 AND 9007199254740991);
