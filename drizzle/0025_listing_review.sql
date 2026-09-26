CREATE TABLE "listing_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rentable_id" uuid NOT NULL,
	"content_version" integer NOT NULL,
	"pass_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_to" uuid
);
--> statement-breakpoint
ALTER TABLE "listing_review" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "rentable" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_submission" ADD CONSTRAINT "listing_submission_rentable_id_rentable_id_fk" FOREIGN KEY ("rentable_id") REFERENCES "public"."rentable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_submission" ADD CONSTRAINT "listing_submission_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_submission" ADD CONSTRAINT "listing_submission_assigned_to_admin_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_submission_pass_idx" ON "listing_submission" USING btree ("rentable_id","pass_number");--> statement-breakpoint
ALTER TABLE "listing_review" ADD CONSTRAINT "listing_review_submission_id_listing_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."listing_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_review_submission_idx" ON "listing_review" USING btree ("submission_id");
--> statement-breakpoint
-- Content edits invalidate the reviewed revision. Status/assignment bookkeeping does not.
CREATE FUNCTION version_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','status','prior_status','approved_snapshot','rejection_reason','review_pass','content_version','rating_avg','review_count','verified_at','verified_by','availability_confirmed_at']) THEN
    NEW.content_version := OLD.content_version + 1;
  END IF;
  IF NEW.content_version <> OLD.content_version AND OLD.status='pending_verification' THEN
    NEW.status := 'pending_review';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER rentable_content_version BEFORE UPDATE ON rentable FOR EACH ROW EXECUTE FUNCTION version_listing_content();
--> statement-breakpoint
-- Parent-first locking serializes submission/decision with edits to child records.
CREATE FUNCTION version_listing_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id uuid; next_id uuid;
BEGIN
  IF TG_TABLE_NAME='document' THEN
    IF TG_OP <> 'INSERT' AND OLD.owner_type='rentable' THEN previous_id := OLD.owner_id; END IF;
    IF TG_OP <> 'DELETE' AND NEW.owner_type='rentable' THEN next_id := NEW.owner_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN previous_id := OLD.rentable_id; END IF;
    IF TG_OP <> 'DELETE' THEN next_id := NEW.rentable_id; END IF;
  END IF;
  IF previous_id IS NOT NULL THEN UPDATE rentable SET content_version=content_version+1 WHERE id=previous_id; END IF;
  IF next_id IS NOT NULL AND next_id IS DISTINCT FROM previous_id THEN
    UPDATE rentable SET content_version=content_version+1 WHERE id=next_id;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
--> statement-breakpoint
CREATE TRIGGER price_content_version BEFORE INSERT OR UPDATE OR DELETE ON rentable_price FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER amenity_content_version BEFORE INSERT OR UPDATE OR DELETE ON rentable_amenity FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE TRIGGER document_content_version BEFORE INSERT OR UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION version_listing_child();
--> statement-breakpoint
CREATE FUNCTION preserve_listing_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Submitted property evidence cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-'assigned_to') IS DISTINCT FROM (to_jsonb(OLD)-'assigned_to') THEN
    RAISE EXCEPTION 'Submitted property evidence is immutable';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER listing_submission_immutable BEFORE UPDATE OR DELETE ON listing_submission FOR EACH ROW EXECUTE FUNCTION preserve_listing_submission();
