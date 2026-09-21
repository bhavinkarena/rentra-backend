CREATE TABLE "review_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_report_valid_chk" CHECK ("review_report"."state" IN ('open','closed') AND length(trim("review_report"."reason")) BETWEEN 10 AND 1000 AND ("review_report"."state"='open' OR ("review_report"."resolution" IS NOT NULL AND "review_report"."resolved_by" IS NOT NULL AND "review_report"."resolved_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "moderation_state" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "moderation_reason" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "owner_reply" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "replied_by" uuid;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_report" ADD CONSTRAINT "review_report_review_id_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_report" ADD CONSTRAINT "review_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_report" ADD CONSTRAINT "review_report_resolved_by_admin_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_report_author_idx" ON "review_report" USING btree ("review_id","reporter_id");--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_moderated_by_admin_user_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."admin_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_replied_by_user_id_fk" FOREIGN KEY ("replied_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Preserve legacy content, but require fresh evidence and moderation before any public display.
UPDATE review SET published_at=NULL;
--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_scores_chk" CHECK ("review"."rating" BETWEEN 1 AND 5 AND ("review"."cleanliness" IS NULL OR "review"."cleanliness" BETWEEN 1 AND 5) AND ("review"."accuracy" IS NULL OR "review"."accuracy" BETWEEN 1 AND 5) AND ("review"."value_for_money" IS NULL OR "review"."value_for_money" BETWEEN 1 AND 5)) NOT VALID;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_moderation_chk" CHECK ("review"."moderation_state" IN ('pending','published','rejected','hidden') AND ("review"."moderation_state"='published') = ("review"."published_at" IS NOT NULL) AND "review"."version">=0);--> statement-breakpoint
CREATE FUNCTION rentra_review_eligible(visit uuid, author uuid, listing uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM booking b JOIN rentable r ON r.id=b.rentable_id
 WHERE b.id=visit AND b.customer_id=author AND b.rentable_id=listing AND r.client_id<>author
 AND b.order_id IS NOT NULL AND b.state='completed' AND b.visit_provenance='real' AND b.hours_known
 AND (SELECT count(DISTINCT e.kind) FROM visit_evidence e WHERE e.booking_id=b.id AND e.nature='actual')=3)
$$;
--> statement-breakpoint
CREATE VIEW public_customer_review AS
 SELECT r.* FROM review r WHERE r.author_role='customer' AND r.moderation_state='published' AND r.published_at IS NOT NULL
 AND rentra_review_eligible(r.booking_id,r.author_id,r.rentable_id);
--> statement-breakpoint
CREATE FUNCTION rentra_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.booking_id,NEW.rentable_id,NEW.author_id,NEW.author_role,NEW.rating,NEW.cleanliness,NEW.accuracy,NEW.value_for_money,NEW.body)
   IS DISTINCT FROM (OLD.booking_id,OLD.rentable_id,OLD.author_id,OLD.author_role,OLD.rating,OLD.cleanliness,OLD.accuracy,OLD.value_for_money,OLD.body) THEN
   RAISE EXCEPTION 'Submitted review content is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.author_role='customer' AND (TG_OP='INSERT' OR NEW.moderation_state='published') AND
   NOT rentra_review_eligible(NEW.booking_id,NEW.author_id,NEW.rentable_id) THEN
   RAISE EXCEPTION 'Actual completed visit required' USING ERRCODE='23514';
 END IF;
 IF NEW.moderation_state='published' AND (NEW.author_role<>'customer' OR NEW.moderated_by IS NULL OR NEW.moderated_at IS NULL
   OR NOT EXISTS(SELECT 1 FROM admin_user WHERE id=NEW.moderated_by AND is_active)) THEN
   RAISE EXCEPTION 'Active moderator required' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER review_guard BEFORE INSERT OR UPDATE ON review FOR EACH ROW EXECUTE FUNCTION rentra_review_guard();
--> statement-breakpoint
CREATE FUNCTION rentra_review_totals(listing uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE rentable SET rating_avg=(SELECT round(avg(rating)::numeric,2)::real FROM public_customer_review WHERE rentable_id=listing),
 review_count=(SELECT count(*)::int FROM public_customer_review WHERE rentable_id=listing) WHERE id=listing
$$;
--> statement-breakpoint
CREATE FUNCTION rentra_review_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM rentra_review_totals(OLD.rentable_id); RETURN OLD; END IF;
 PERFORM rentra_review_totals(NEW.rentable_id); RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER review_refresh AFTER INSERT OR UPDATE OR DELETE ON review FOR EACH ROW EXECUTE FUNCTION rentra_review_refresh();
--> statement-breakpoint
CREATE TRIGGER review_visit_refresh AFTER UPDATE OF state ON booking FOR EACH ROW EXECUTE FUNCTION rentra_review_refresh();
--> statement-breakpoint
-- Derived listing scores cannot be replaced by seed/manual claims.
CREATE FUNCTION rentra_review_cache_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT count(*)::int,round(avg(rating)::numeric,2)::real INTO NEW.review_count,NEW.rating_avg
 FROM public_customer_review WHERE rentable_id=NEW.id;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER review_cache_guard BEFORE INSERT OR UPDATE OF rating_avg,review_count ON rentable FOR EACH ROW EXECUTE FUNCTION rentra_review_cache_guard();
--> statement-breakpoint
UPDATE rentable SET review_count=0,rating_avg=NULL;
