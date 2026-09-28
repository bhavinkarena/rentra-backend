ALTER TABLE "amenity" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "area" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "area" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "area" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "city" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "city" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Check new references at write time too: an owner may have opened a form before
-- an administrator archived an unused entry. Existing references remain valid.
CREATE FUNCTION catalogue_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'rentable' THEN
  IF TG_OP = 'INSERT' OR NEW.city_id IS DISTINCT FROM OLD.city_id OR NEW.area_id IS DISTINCT FROM OLD.area_id OR NEW.category_id IS DISTINCT FROM OLD.category_id THEN
   PERFORM 1 FROM city WHERE id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM area WHERE id=NEW.area_id AND city_id=NEW.city_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active area in this city' USING ERRCODE='23514'; END IF;
   PERFORM 1 FROM category WHERE id=NEW.category_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active category' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF TG_OP = 'INSERT' OR NEW.amenity_id IS DISTINCT FROM OLD.amenity_id THEN
   PERFORM 1 FROM amenity WHERE id=NEW.amenity_id AND is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active amenity' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER catalogue_rentable_reference_guard BEFORE INSERT OR UPDATE ON rentable FOR EACH ROW EXECUTE FUNCTION catalogue_reference_guard();
--> statement-breakpoint
CREATE TRIGGER catalogue_amenity_reference_guard BEFORE INSERT OR UPDATE ON rentable_amenity FOR EACH ROW EXECUTE FUNCTION catalogue_reference_guard();
