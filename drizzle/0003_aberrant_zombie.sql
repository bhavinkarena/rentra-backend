CREATE TYPE "public"."account_status" AS ENUM('pending_application', 'active', 'suspended', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('client', 'customer', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."otp_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('login', 'verify_email', 'verify_phone');--> statement-breakpoint
ALTER TYPE "public"."kyc_status" ADD VALUE 'more_info_needed';--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "audit_actor" NOT NULL,
	"actor_id" uuid,
	"entity" varchar(64) NOT NULL,
	"entity_id" varchar(64),
	"action" varchar(64) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" varchar(45),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" varchar(254) NOT NULL,
	"channel" "otp_channel" NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"request_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "account_status" "account_status" DEFAULT 'pending_application' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "preferred_locale" varchar(5) DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_type","actor_id","at");--> statement-breakpoint
CREATE INDEX "otp_lookup_idx" ON "otp_token" USING btree ("identifier","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_role_idx" ON "user" USING btree ("email","role");--> statement-breakpoint
CREATE INDEX "user_status_idx" ON "user" USING btree ("role","account_status");--> statement-breakpoint

-- Hand-appended backfill. The new columns default correctly for NEW rows, but
-- the already-seeded demo users would land in 'pending_application' while
-- owning 12 live listings, which is an impossible state. Existing seed rows
-- represent verified, approved accounts, so say so explicitly.
UPDATE "user"
   SET "account_status"    = 'active',
       "email_verified_at" = COALESCE("email_verified_at", now()),
       "phone_verified_at" = COALESCE("phone_verified_at", now()),
       "preferred_locale"  = CASE WHEN "role" = 'client' THEN 'gu' ELSE 'en' END
 WHERE "account_status" = 'pending_application';
