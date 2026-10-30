-- Story 4.1: a guest's contextual stay issue is a support_request category. Additive: existing rows,
-- categories and states are unchanged; the structured intake lives in context jsonb.
ALTER TABLE "support_request" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_request" ADD COLUMN "late" boolean;--> statement-breakpoint
ALTER TABLE "support_request" DROP CONSTRAINT "support_request_valid_chk";--> statement-breakpoint
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_valid_chk" CHECK ("support_request"."category" IN ('booking','change','cancellation','payment','privacy','other','verification','account','property','calendar','earnings','stay_issue')
    AND "support_request"."state" IN ('open','in_progress','waiting_customer','resolved') AND "support_request"."version">=0
    AND length(trim("support_request"."subject")) BETWEEN 5 AND 120 AND "support_request"."request_hash" ~ '^[a-f0-9]{64}$'
    AND ("support_request"."client_id" IS NOT NULL OR "support_request"."category" NOT IN ('booking','change','cancellation','payment') OR "support_request"."order_id" IS NOT NULL)
    AND ("support_request"."client_id" IS NOT NULL OR "support_request"."category" NOT IN ('verification','account','property','calendar','earnings'))
    AND ("support_request"."privacy_request_id" IS NULL OR ("support_request"."category"='privacy' AND "support_request"."order_id" IS NULL))
    AND ("support_request"."category"<>'stay_issue' OR ("support_request"."customer_id" IS NOT NULL AND "support_request"."order_id" IS NOT NULL AND "support_request"."discovered_at" IS NOT NULL AND "support_request"."late" IS NOT NULL)));
