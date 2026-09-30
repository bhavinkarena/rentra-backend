-- Phase 5 of docs/DATABASE-REVIEW.md: one store per fact.
--   per-date price  -> booking_price_override (paise)
--   owner block     -> inventory_reservation (source 'owner_block')
--   availability    -> the open-date calendar only

-- 1. Legacy rupee overrides. Explicit rows already win in quotes, so existing explicit rows are kept.
INSERT INTO booking_price_override (rentable_id, day, slot, rent_minor)
SELECT rentable_id, day, slot::text::booking_slot, price_override::bigint * 100
  FROM availability WHERE price_override IS NOT NULL
ON CONFLICT (rentable_id, day, slot) DO NOTHING;--> statement-breakpoint

-- 2. Legacy owner blocks. The interval is computed exactly as visitInterval() does:
--    property-local start/end from the listing's slot schedule, widened by its buffers.
CREATE TEMP TABLE legacy_block ON COMMIT DROP AS
SELECT a.rentable_id, a.day, a.slot, r.client_id,
  CASE WHEN s ? 'startTime' AND s ? 'endTime'
        AND s->>'startTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND s->>'endTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND (s->>'endDayOffset') IN ('0', '1') AND (s->>'endDayOffset')::int = CASE a.slot WHEN 'day' THEN 0 ELSE 1 END
        AND (s->>'bufferBeforeMinutes') ~ '^[0-9]{1,4}$' AND (s->>'bufferAfterMinutes') ~ '^[0-9]{1,4}$'
    THEN tstzrange(
      ((a.day + (s->>'startTime')::time) AT TIME ZONE 'Asia/Kolkata') - make_interval(mins => (s->>'bufferBeforeMinutes')::int),
      ((a.day + (s->>'endDayOffset')::int + (s->>'endTime')::time) AT TIME ZONE 'Asia/Kolkata') + make_interval(mins => (s->>'bufferAfterMinutes')::int),
      '[)')
  END AS blocked
FROM availability a
JOIN rentable r ON r.id = a.rentable_id
CROSS JOIN LATERAL (SELECT r.booking_config->'slots'->(a.slot::text) AS s) sched
WHERE a.blocked_by_client;--> statement-breakpoint

-- Adjacent day/night blocks can overlap through their buffers; merge per listing
-- so the ledger's exclusion constraint accepts them. Only future intervals matter.
CREATE TEMP TABLE merged_block ON COMMIT DROP AS
SELECT rentable_id, client_id, unnest(range_agg(blocked)) AS blocked
FROM legacy_block
WHERE blocked IS NOT NULL AND NOT isempty(blocked) AND upper(blocked) > now()
GROUP BY rentable_id, client_id;--> statement-breakpoint

-- A block that overlaps an active hold or booking is left out; the fallback below still closes its date.
INSERT INTO inventory_reservation (rentable_id, source, blocked_start_at, blocked_end_at, state, created_by, reason)
SELECT m.rentable_id, 'owner_block', lower(m.blocked), upper(m.blocked), 'committed', m.client_id,
  'Owner block migrated from the legacy calendar'
FROM merged_block m
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_reservation x
  WHERE x.rentable_id = m.rentable_id AND x.state IN ('held', 'committed')
    AND tstzrange(x.blocked_start_at, x.blocked_end_at, '[)') && m.blocked);--> statement-breakpoint

-- Fallback: any legacy block not represented in the ledger (no slot hours, or a conflict)
-- keeps its date closed through the open-date calendar instead.
UPDATE availability a SET units_available = 0
FROM legacy_block b
WHERE a.rentable_id = b.rentable_id AND a.day = b.day AND a.slot = b.slot
  AND NOT EXISTS (
    SELECT 1 FROM inventory_reservation x
    WHERE x.rentable_id = b.rentable_id AND x.source = 'owner_block' AND x.state = 'committed'
      AND b.blocked IS NOT NULL AND tstzrange(x.blocked_start_at, x.blocked_end_at, '[)') @> b.blocked);--> statement-breakpoint

ALTER TABLE availability DROP COLUMN price_override, DROP COLUMN blocked_by_client;
