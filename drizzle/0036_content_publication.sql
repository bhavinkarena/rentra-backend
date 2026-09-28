CREATE TABLE "content_draft" (
	"kind" varchar(20) PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'draft' NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"based_on_version" varchar(32),
	CONSTRAINT "content_draft_kind_chk" CHECK ("content_draft"."kind" IN ('terms','privacy','cancellation','help','contact')),
	CONSTRAINT "content_draft_state_chk" CHECK ("content_draft"."state" IN ('draft','reviewed','published') AND "content_draft"."version">0)
);
--> statement-breakpoint
CREATE TABLE "content_publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"version" varchar(32) NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"published_by" uuid NOT NULL,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reason" text NOT NULL,
	"based_on_version" varchar(32),
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_publication_review_chk" CHECK (("content_publication"."is_baseline"=false AND "content_publication"."reviewed_by" IS NOT NULL) OR ("content_publication"."is_baseline"=true AND "content_publication"."kind"='contact' AND "content_publication"."version"='2026-09-21')),
	CONSTRAINT "content_publication_kind_chk" CHECK ("content_publication"."kind" IN ('terms','privacy','cancellation','help','contact'))
);
--> statement-breakpoint
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_updated_by_admin_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_draft" ADD CONSTRAINT "content_draft_reviewed_by_admin_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication" ADD CONSTRAINT "content_publication_published_by_admin_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_publication" ADD CONSTRAINT "content_publication_reviewed_by_admin_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admin_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_publication_version_idx" ON "content_publication" USING btree ("kind","version");--> statement-breakpoint
CREATE INDEX "content_publication_current_idx" ON "content_publication" USING btree ("kind","effective_at");
--> statement-breakpoint
CREATE FUNCTION protect_content_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Published content is immutable; publish a new version' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER content_publication_immutable BEFORE UPDATE OR DELETE ON content_publication FOR EACH ROW EXECUTE FUNCTION protect_content_publication();
