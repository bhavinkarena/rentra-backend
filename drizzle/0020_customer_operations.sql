CREATE TABLE "customer_measurement" (
	"day" date NOT NULL,
	"event" varchar(32) NOT NULL,
	"source" varchar(8) NOT NULL,
	"device" varchar(8) NOT NULL,
	"visits" varchar(8) NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "customer_measurement_day_event_source_device_visits_pk" PRIMARY KEY("day","event","source","device","visits"),
	CONSTRAINT "customer_measurement_bounds_chk" CHECK ("customer_measurement"."count" BETWEEN 1 AND 1000000
    AND "customer_measurement"."device" IN ('mobile','desktop','unknown') AND "customer_measurement"."visits" IN ('single','multiple','unknown')
    AND (("customer_measurement"."source"='browser' AND "customer_measurement"."event" IN ('search_submitted','listing_viewed','dates_selected','history_viewed','share_attempted','share_completed'))
      OR ("customer_measurement"."source"='server' AND "customer_measurement"."event" IN ('quote_ready','login_completed','checkout_started','inventory_conflict','quote_changed','payment_unavailable','otp_request_rejected','otp_rejected'))))
);
--> statement-breakpoint
CREATE TABLE "service_health" (
	"service" varchar(16) PRIMARY KEY NOT NULL,
	"healthy" boolean NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "service_health_name_chk" CHECK ("service_health"."service" IN ('payments','notifications'))
);
