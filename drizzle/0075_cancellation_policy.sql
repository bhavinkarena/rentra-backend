-- Story 2.6 (FR-9/FR-10): owner-configured percentage cancellation windows.
-- rentable.cancellation_policy is the listing policy, or the hotel default. rate_plan.cancellation_policy
-- NULL means the plan uses the hotel default. Accepted bookings keep the policy snapshotted at checkout.
-- Old tier/plan columns stay until every reader has moved; existing presets map to windows (user decision).
ALTER TABLE rentable ADD COLUMN cancellation_policy jsonb;--> statement-breakpoint
ALTER TABLE rate_plan ADD COLUMN cancellation_policy jsonb;--> statement-breakpoint
CREATE FUNCTION rentra_cancellation_windows(windows jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('version', 1, 'windows', windows, 'atOrAfterCheckInPct', 0,
    'earlyDeparture', jsonb_build_object('offered', false, 'pct', 0))
$$;--> statement-breakpoint
UPDATE rentable SET cancellation_policy = rentra_cancellation_windows(CASE
  WHEN rental_unit::text = 'hour' THEN CASE cancellation_tier::text
    WHEN 'flexible' THEN '[{"hoursBefore":4,"pct":100},{"hoursBefore":0,"pct":0}]'
    WHEN 'strict' THEN '[{"hoursBefore":48,"pct":50},{"hoursBefore":0,"pct":0}]'
    ELSE '[{"hoursBefore":24,"pct":100},{"hoursBefore":6,"pct":50},{"hoursBefore":0,"pct":0}]' END
  ELSE CASE cancellation_tier::text
    WHEN 'flexible' THEN '[{"hoursBefore":72,"pct":100},{"hoursBefore":0,"pct":50}]'
    WHEN 'strict' THEN '[{"hoursBefore":168,"pct":50},{"hoursBefore":0,"pct":0}]'
    ELSE '[{"hoursBefore":168,"pct":100},{"hoursBefore":72,"pct":50},{"hoursBefore":0,"pct":0}]' END
  END::jsonb)
WHERE rental_unit::text <> 'night';--> statement-breakpoint
-- Hotel plans: 100% before their free-cancellation hours, then 0% (user decision). Each existing plan keeps
-- its own terms explicitly; the hotel default starts as the oldest plan's terms.
UPDATE rate_plan SET cancellation_policy = rentra_cancellation_windows(CASE WHEN free_cancel_hours IS NULL
  THEN '[{"hoursBefore":0,"pct":0}]'::jsonb
  ELSE jsonb_build_array(jsonb_build_object('hoursBefore', free_cancel_hours, 'pct', 100), '{"hoursBefore":0,"pct":0}'::jsonb) END);--> statement-breakpoint
UPDATE rentable r SET cancellation_policy = coalesce(
  (SELECT p.cancellation_policy FROM rate_plan p WHERE p.rentable_id = r.id ORDER BY p.sort_order, p.id LIMIT 1),
  rentra_cancellation_windows('[{"hoursBefore":72,"pct":100},{"hoursBefore":0,"pct":0}]'))
WHERE rental_unit::text = 'night';--> statement-breakpoint
DROP FUNCTION rentra_cancellation_windows(jsonb);
