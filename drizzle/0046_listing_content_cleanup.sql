-- Phase 5b of docs/DATABASE-REVIEW.md: rentable_amenity is the only amenity store;
-- the published snapshot is read through rentable.published_submission_id.

-- Listings that still rely on free-text amenity labels get taxonomy rows. A label matches an
-- active amenity by its English label, exactly or as a prefix ("Swimming pool 15x25" -> pool, value "15x25").
CREATE TEMP TABLE legacy_amenity ON COMMIT DROP AS
SELECT DISTINCT ON (r.id, label.value) r.id AS rentable_id, label.value AS label, a.id AS amenity_id,
  CASE WHEN a.value_type <> 'none' THEN nullif(left(trim(substr(label.value, length(a.label_en) + 1)), 40), '') END AS value
FROM rentable r
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.amenities) = 'array' THEN r.amenities ELSE '[]'::jsonb END) AS label(value)
LEFT JOIN amenity a ON a.is_active
  AND (lower(trim(label.value)) = lower(a.label_en) OR lower(trim(label.value)) LIKE lower(a.label_en) || ' %')
WHERE NOT EXISTS (SELECT 1 FROM rentable_amenity ra WHERE ra.rentable_id = r.id)
ORDER BY r.id, label.value, length(a.label_en) DESC NULLS LAST;--> statement-breakpoint

-- Same content in a new store: this is not an owner edit, so the listing's content version must not move.
ALTER TABLE rentable_amenity DISABLE TRIGGER amenity_content_version;--> statement-breakpoint
INSERT INTO rentable_amenity (rentable_id, amenity_id, value)
SELECT DISTINCT ON (rentable_id, amenity_id) rentable_id, amenity_id, value
FROM legacy_amenity WHERE amenity_id IS NOT NULL
ORDER BY rentable_id, amenity_id, value NULLS LAST
ON CONFLICT (rentable_id, amenity_id) DO NOTHING;--> statement-breakpoint
ALTER TABLE rentable_amenity ENABLE TRIGGER amenity_content_version;--> statement-breakpoint

-- Labels with no taxonomy match are kept in the append-only audit log.
INSERT INTO audit_log (actor_type, entity, entity_id, action, "before", reason)
SELECT 'system', 'rentable', rentable_id::text, 'legacy_amenity_labels_archived',
  jsonb_build_object('labels', jsonb_agg(label ORDER BY label)),
  'Free-text amenity labels with no taxonomy match; column removed by migration 0046'
FROM legacy_amenity WHERE amenity_id IS NULL
GROUP BY rentable_id;--> statement-breakpoint

-- Listings that already had taxonomy rows kept a free-text copy that was never shown; keep it on record too.
INSERT INTO audit_log (actor_type, entity, entity_id, action, "before", reason)
SELECT 'system', 'rentable', r.id::text, 'legacy_amenity_labels_archived', jsonb_build_object('labels', r.amenities),
  'Free-text amenity copy alongside taxonomy rows; column removed by migration 0046'
FROM rentable r
WHERE jsonb_typeof(r.amenities) = 'array' AND jsonb_array_length(r.amenities) > 0
  AND NOT EXISTS (SELECT 1 FROM legacy_amenity l WHERE l.rentable_id = r.id);--> statement-breakpoint

ALTER TABLE rentable DROP COLUMN amenities, DROP COLUMN approved_snapshot;
