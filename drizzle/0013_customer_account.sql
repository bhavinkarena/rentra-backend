CREATE TABLE "customer_privacy_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_privacy_kind_chk" CHECK ("customer_privacy_request"."kind" IN ('access', 'deletion')),
	CONSTRAINT "customer_privacy_state_chk" CHECK ("customer_privacy_request"."state" IN ('open', 'in_review', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "customer_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_otp_challenge" ADD COLUMN "purpose" varchar(16) DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_otp_challenge" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_otp_challenge" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_otp_challenge" ADD COLUMN "original_phone" varchar(15);--> statement-breakpoint
ALTER TABLE "customer_privacy_request" ADD CONSTRAINT "customer_privacy_request_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_privacy_active_idx" ON "customer_privacy_request" USING btree ("customer_id","kind") WHERE "customer_privacy_request"."state" <> 'closed';--> statement-breakpoint
CREATE INDEX "customer_privacy_queue_idx" ON "customer_privacy_request" USING btree ("state","created_at");--> statement-breakpoint
ALTER TABLE "customer_otp_challenge" ADD CONSTRAINT "customer_otp_challenge_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;