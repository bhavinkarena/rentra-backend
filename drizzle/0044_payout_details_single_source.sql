-- Phase 4 of docs/DATABASE-REVIEW.md: payout_destination is the only store of payout details.

-- The current destination per client, in the shape the application screens already use.
CREATE VIEW client_payout_current AS
  SELECT d.client_id,
    d.id AS destination_id,
    d.upi_id AS payout_upi_id,
    CASE WHEN d.method = 'bank' THEN '••••' || d.account_last4 END AS payout_account_ref,
    d.ifsc AS payout_ifsc,
    d.holder_name AS payout_holder_name,
    CASE d.name_check WHEN 'same' THEN true WHEN 'different' THEN false END AS payout_name_match
  FROM payout_destination d
  WHERE d.state IN ('submitted', 'verified');--> statement-breakpoint

-- Legacy-only details (rows 0033 could not import) are kept in the append-only audit log before the drop.
INSERT INTO audit_log (actor_type, entity, entity_id, action, "before", reason)
SELECT 'system', 'client_application', a.id::text, 'legacy_payout_details_archived',
  jsonb_build_object('upiId', coalesce(a.payout_upi_id, u.payout_upi_id), 'accountRef', coalesce(a.payout_account_ref, u.payout_bank_ref),
    'ifsc', a.payout_ifsc, 'holderName', a.payout_holder_name, 'nameMatch', a.payout_name_match),
  'Payout details existed only in legacy columns removed by migration 0044'
FROM client_application a JOIN "user" u ON u.id = a.user_id
WHERE (a.payout_upi_id IS NOT NULL OR a.payout_account_ref IS NOT NULL OR u.payout_upi_id IS NOT NULL OR u.payout_bank_ref IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM payout_destination d WHERE d.client_id = a.user_id);--> statement-breakpoint

ALTER TABLE "user" DROP COLUMN payout_upi_id, DROP COLUMN payout_bank_ref;--> statement-breakpoint
ALTER TABLE client_application DROP COLUMN payout_upi_id, DROP COLUMN payout_account_ref,
  DROP COLUMN payout_ifsc, DROP COLUMN payout_holder_name, DROP COLUMN payout_name_match;
