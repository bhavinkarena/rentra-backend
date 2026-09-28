CREATE TABLE "privacy_job" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(16) DEFAULT 'queued' NOT NULL,
	"stage" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" varchar(64),
	"artifact_ciphertext" text,
	"expires_at" timestamp with time zone,
	"photo_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_job_state_chk" CHECK ("privacy_job"."state" IN ('queued','running','failed','completed') AND "privacy_job"."stage" BETWEEN 0 AND 4 AND "privacy_job"."attempts">=0)
);
--> statement-breakpoint
ALTER TABLE "customer_privacy_request" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_privacy_request" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "customer_privacy_request" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "privacy_erasure_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "privacy_erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "privacy_job" ADD CONSTRAINT "privacy_job_request_id_customer_privacy_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."customer_privacy_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_job_work_idx" ON "privacy_job" USING btree ("state","updated_at");