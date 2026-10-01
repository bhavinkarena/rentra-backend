-- Entertainment plan, Phase 4: aggregate measurement by vertical, plus the time-booking browser events.
-- Ships with the insert code whose ON CONFLICT target changes (src/services/operations/measurement.js).
ALTER TABLE customer_measurement ADD COLUMN vertical varchar(24) NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE customer_measurement DROP CONSTRAINT customer_measurement_day_event_source_device_visits_pk;
--> statement-breakpoint
ALTER TABLE customer_measurement ADD CONSTRAINT customer_measurement_pk PRIMARY KEY (day, event, source, device, visits, vertical);
--> statement-breakpoint
ALTER TABLE customer_measurement DROP CONSTRAINT customer_measurement_bounds_chk;
--> statement-breakpoint
ALTER TABLE customer_measurement ADD CONSTRAINT customer_measurement_bounds_chk CHECK (count BETWEEN 1 AND 1000000
  AND device IN ('mobile','desktop','unknown') AND visits IN ('single','multiple','unknown')
  AND vertical IN ('farmhouse','entertainment','unknown')
  AND ((source='browser' AND event IN ('search_submitted','listing_viewed','dates_selected','history_viewed','share_attempted','share_completed',
        'vertical_switched','times_viewed','time_selected'))
    OR (source='server' AND event IN ('quote_ready','login_completed','checkout_started','inventory_conflict','quote_changed','payment_unavailable','otp_request_rejected','otp_rejected'))));
