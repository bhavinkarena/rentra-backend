CREATE TABLE "customer_auth_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_hash" varchar(64) NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_otp_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" varchar(10) NOT NULL,
	"browser_hash" varchar(64) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"delivery_mode" varchar(16) NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_auth_phone_rate_idx" ON "customer_auth_rate" USING btree ("phone_hash","kind","created_at");--> statement-breakpoint
CREATE INDEX "customer_auth_ip_rate_idx" ON "customer_auth_rate" USING btree ("ip_hash","kind","created_at");--> statement-breakpoint
CREATE INDEX "customer_otp_phone_idx" ON "customer_otp_challenge" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "customer_session_user_idx" ON "customer_session" USING btree ("user_id");--> statement-breakpoint
-- Revocation is durable even if staff later reactivate the account.
CREATE FUNCTION revoke_customer_sessions_on_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role OR
     (NEW.account_status IS DISTINCT FROM OLD.account_status AND NEW.account_status <> 'active') THEN
    UPDATE customer_session SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_status_session_revocation AFTER UPDATE OF account_status, role ON "user"
FOR EACH ROW EXECUTE FUNCTION revoke_customer_sessions_on_status_change();
