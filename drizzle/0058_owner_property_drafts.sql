ALTER TABLE rentable ALTER COLUMN city_id DROP NOT NULL;
ALTER TABLE rentable ALTER COLUMN area_id DROP NOT NULL;
ALTER TABLE rentable ADD CONSTRAINT rentable_published_location_required CHECK (status='draft' OR (city_id IS NOT NULL AND area_id IS NOT NULL));
INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
SELECT 'system',NULL,'rentable',r.id,'extra_guest_charge_normalised',jsonb_build_object('charge',r.extra_guest_charge_minor),jsonb_build_object('charge',greatest(r.extra_guest_charge_minor,coalesce(max((v.value->>'extraGuestChargeMinor')::bigint),0))) FROM rentable r LEFT JOIN LATERAL jsonb_each(coalesce(r.booking_config->'slots','{}')) v ON true GROUP BY r.id HAVING count(DISTINCT (v.value->>'extraGuestChargeMinor')::bigint)>1 OR max((v.value->>'extraGuestChargeMinor')::bigint)>r.extra_guest_charge_minor;
-- Keep a single extra-guest source; preserve the highest historical charge.
WITH charges AS (SELECT r.id, greatest(r.extra_guest_charge_minor, coalesce(max((s.value->>'extraGuestChargeMinor')::bigint),0)) charge FROM rentable r LEFT JOIN LATERAL jsonb_each(coalesce(r.booking_config->'slots','{}')) s ON true GROUP BY r.id)
UPDATE rentable r SET extra_guest_charge_minor=c.charge FROM charges c WHERE r.id=c.id AND r.extra_guest_charge_minor<>c.charge;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION catalogue_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE new_vertical varchar(24); old_vertical varchar(24); category_unit text;
BEGIN
 IF TG_TABLE_NAME = 'rentable' THEN
  IF TG_OP = 'INSERT' OR NEW.city_id IS DISTINCT FROM OLD.city_id OR NEW.area_id IS DISTINCT FROM OLD.area_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id OR NEW.rental_unit IS DISTINCT FROM OLD.rental_unit THEN
   IF NEW.city_id IS NOT NULL OR NEW.area_id IS NOT NULL THEN
   PERFORM 1 FROM city WHERE id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM area WHERE id=NEW.area_id AND city_id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active area in this city' USING ERRCODE='23514'; END IF;
   END IF;
   SELECT vertical_code, default_rental_unit::text INTO new_vertical, category_unit
     FROM category WHERE id=NEW.category_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active category' USING ERRCODE='23514'; END IF;
   IF NEW.rental_unit::text IS DISTINCT FROM category_unit THEN
     RAISE EXCEPTION 'The listing booking model must match its category' USING ERRCODE='23514';
   END IF;
   IF TG_OP = 'UPDATE' AND NEW.category_id IS DISTINCT FROM OLD.category_id THEN
     SELECT vertical_code INTO old_vertical FROM category WHERE id=OLD.category_id;
     IF old_vertical IS DISTINCT FROM new_vertical THEN
       RAISE EXCEPTION 'A listing cannot move to another vertical' USING ERRCODE='23514';
     END IF;
   END IF;
  END IF;
 ELSE
  IF TG_OP = 'INSERT' OR NEW.amenity_id IS DISTINCT FROM OLD.amenity_id THEN
   PERFORM 1 FROM amenity WHERE id=NEW.amenity_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active amenity' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM amenity_vertical av JOIN category c ON c.vertical_code = av.vertical_code
     JOIN rentable r ON r.category_id = c.id
     WHERE r.id = NEW.rentable_id AND av.amenity_id = NEW.amenity_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'This amenity is not offered for this kind of listing' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- LIST-07: one-sided slot prices are already unsellable on the zero side (R0). Log them for owner
-- review instead of inventing a weekday or weekend price the owner never chose.
INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
SELECT 'system',NULL,'rentable',rentable_id,'one_sided_price_needs_owner',
  jsonb_build_object('slot',slot,'weekdayMinor',weekday_minor,'weekendMinor',weekend_minor),NULL
FROM rentable_price WHERE (weekday_minor=0) <> (weekend_minor=0);
