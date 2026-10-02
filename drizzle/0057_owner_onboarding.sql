ALTER TABLE "user" ADD COLUMN owner_guide jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_owner_guide_object_chk CHECK (jsonb_typeof(owner_guide)='object');
