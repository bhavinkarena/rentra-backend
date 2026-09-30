-- Phase 1 of docs/DATABASE-REVIEW.md: additive integrity and index work.
-- No row data changes except the guarded review repair and processed webhook job cleanup.

-- Pre-checks: fail with a clear message instead of a bare constraint error.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM rentable r JOIN area a ON a.id = r.area_id WHERE a.city_id <> r.city_id;
  IF n > 0 THEN RAISE EXCEPTION '0041: % listings have an area from another city; fix rentable.city_id first', n; END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM "user" WHERE email IS NOT NULL GROUP BY lower(email), role HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '0041: % case-insensitive duplicate emails per role; merge them first', n; END IF;
  SELECT count(*) INTO n FROM verification_visit v JOIN listing_submission s ON s.id = v.submission_id WHERE s.rentable_id <> v.rentable_id;
  IF n > 0 THEN RAISE EXCEPTION '0041: % verification visits point at another listing''s submission', n; END IF;
  SELECT count(*) INTO n FROM listing_review v JOIN listing_submission s ON s.id = v.submission_id WHERE s.rentable_id <> v.rentable_id;
  IF n > 0 THEN RAISE EXCEPTION '0041: % listing reviews point at another listing''s submission', n; END IF;
END $$;
--> statement-breakpoint

-- Review repair: rentable_id must be the visit's listing. review_guard forbids
-- updating these columns, so the repair runs with that trigger paused.
ALTER TABLE review DISABLE TRIGGER review_guard;--> statement-breakpoint
UPDATE review r SET rentable_id = b.rentable_id FROM booking b
  WHERE b.id = r.booking_id AND r.rentable_id IS DISTINCT FROM b.rentable_id;--> statement-breakpoint
ALTER TABLE review ENABLE TRIGGER review_guard;--> statement-breakpoint
ALTER TABLE review ALTER COLUMN rentable_id SET NOT NULL;--> statement-breakpoint

-- Composite FKs: copied parent ids must match the parent they came from.
CREATE UNIQUE INDEX area_id_city_idx ON area (id, city_id);--> statement-breakpoint
ALTER TABLE rentable ADD CONSTRAINT rentable_area_city_fk
  FOREIGN KEY (area_id, city_id) REFERENCES area (id, city_id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE review ADD CONSTRAINT review_booking_rentable_fk
  FOREIGN KEY (booking_id, rentable_id) REFERENCES booking (id, rentable_id) ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX listing_submission_id_rentable_idx ON listing_submission (id, rentable_id);--> statement-breakpoint
ALTER TABLE listing_review ADD CONSTRAINT listing_review_submission_rentable_fk
  FOREIGN KEY (submission_id, rentable_id) REFERENCES listing_submission (id, rentable_id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE verification_visit ADD CONSTRAINT verification_visit_submission_rentable_fk
  FOREIGN KEY (submission_id, rentable_id) REFERENCES listing_submission (id, rentable_id) ON DELETE RESTRICT;--> statement-breakpoint

-- Delete rules: history is never removed by a cascade and attribution is never nulled.
ALTER TABLE area DROP CONSTRAINT area_city_id_city_id_fk,
  ADD CONSTRAINT area_city_id_city_id_fk FOREIGN KEY (city_id) REFERENCES city(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE review DROP CONSTRAINT review_author_id_user_id_fk,
  ADD CONSTRAINT review_author_id_user_id_fk FOREIGN KEY (author_id) REFERENCES "user"(id) ON DELETE RESTRICT,
  DROP CONSTRAINT review_booking_id_booking_id_fk,
  ADD CONSTRAINT review_booking_id_booking_id_fk FOREIGN KEY (booking_id) REFERENCES booking(id) ON DELETE RESTRICT,
  DROP CONSTRAINT review_moderated_by_admin_user_id_fk,
  ADD CONSTRAINT review_moderated_by_admin_user_id_fk FOREIGN KEY (moderated_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT review_replied_by_user_id_fk,
  ADD CONSTRAINT review_replied_by_user_id_fk FOREIGN KEY (replied_by) REFERENCES "user"(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE review_report DROP CONSTRAINT review_report_resolved_by_admin_user_id_fk,
  ADD CONSTRAINT review_report_resolved_by_admin_user_id_fk FOREIGN KEY (resolved_by) REFERENCES admin_user(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE client_staff DROP CONSTRAINT client_staff_client_id_user_id_fk,
  ADD CONSTRAINT client_staff_client_id_user_id_fk FOREIGN KEY (client_id) REFERENCES "user"(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE client_application DROP CONSTRAINT client_application_user_id_user_id_fk,
  ADD CONSTRAINT client_application_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT,
  DROP CONSTRAINT client_application_reviewed_by_admin_user_id_fk,
  ADD CONSTRAINT client_application_reviewed_by_admin_user_id_fk FOREIGN KEY (reviewed_by) REFERENCES admin_user(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE rentable_amenity DROP CONSTRAINT rentable_amenity_amenity_id_amenity_id_fk,
  ADD CONSTRAINT rentable_amenity_amenity_id_amenity_id_fk FOREIGN KEY (amenity_id) REFERENCES amenity(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE document DROP CONSTRAINT document_reviewed_by_admin_user_id_fk,
  ADD CONSTRAINT document_reviewed_by_admin_user_id_fk FOREIGN KEY (reviewed_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT document_uploaded_by_user_id_fk,
  ADD CONSTRAINT document_uploaded_by_user_id_fk FOREIGN KEY (uploaded_by) REFERENCES "user"(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE listing_review DROP CONSTRAINT listing_review_reviewed_by_admin_user_id_fk,
  ADD CONSTRAINT listing_review_reviewed_by_admin_user_id_fk FOREIGN KEY (reviewed_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT listing_review_submission_id_listing_submission_id_fk,
  ADD CONSTRAINT listing_review_submission_id_listing_submission_id_fk FOREIGN KEY (submission_id) REFERENCES listing_submission(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE listing_submission DROP CONSTRAINT listing_submission_assigned_to_admin_user_id_fk,
  ADD CONSTRAINT listing_submission_assigned_to_admin_user_id_fk FOREIGN KEY (assigned_to) REFERENCES admin_user(id) ON DELETE SET NULL,
  DROP CONSTRAINT listing_submission_rentable_id_rentable_id_fk,
  ADD CONSTRAINT listing_submission_rentable_id_rentable_id_fk FOREIGN KEY (rentable_id) REFERENCES rentable(id) ON DELETE RESTRICT,
  DROP CONSTRAINT listing_submission_submitted_by_user_id_fk,
  ADD CONSTRAINT listing_submission_submitted_by_user_id_fk FOREIGN KEY (submitted_by) REFERENCES "user"(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE rentable DROP CONSTRAINT rentable_area_id_area_id_fk,
  ADD CONSTRAINT rentable_area_id_area_id_fk FOREIGN KEY (area_id) REFERENCES area(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_category_id_category_id_fk,
  ADD CONSTRAINT rentable_category_id_category_id_fk FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_city_id_city_id_fk,
  ADD CONSTRAINT rentable_city_id_city_id_fk FOREIGN KEY (city_id) REFERENCES city(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_published_by_admin_user_id_fk,
  ADD CONSTRAINT rentable_published_by_admin_user_id_fk FOREIGN KEY (published_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_restricted_by_admin_user_id_fk,
  ADD CONSTRAINT rentable_restricted_by_admin_user_id_fk FOREIGN KEY (restricted_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_verified_by_admin_user_id_fk,
  ADD CONSTRAINT rentable_verified_by_admin_user_id_fk FOREIGN KEY (verified_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT rentable_published_submission_id_listing_submission_id_fk,
  ADD CONSTRAINT rentable_published_submission_id_listing_submission_id_fk FOREIGN KEY (published_submission_id) REFERENCES listing_submission(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE verification_visit DROP CONSTRAINT verification_visit_created_by_admin_user_id_fk,
  ADD CONSTRAINT verification_visit_created_by_admin_user_id_fk FOREIGN KEY (created_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT verification_visit_recorded_by_admin_user_id_fk,
  ADD CONSTRAINT verification_visit_recorded_by_admin_user_id_fk FOREIGN KEY (recorded_by) REFERENCES admin_user(id) ON DELETE RESTRICT,
  DROP CONSTRAINT verification_visit_submission_id_listing_submission_id_fk,
  ADD CONSTRAINT verification_visit_submission_id_listing_submission_id_fk FOREIGN KEY (submission_id) REFERENCES listing_submission(id) ON DELETE RESTRICT;--> statement-breakpoint

-- Case-insensitive email uniqueness per role (the plain index stays for ON CONFLICT targets).
CREATE UNIQUE INDEX user_email_role_ci_idx ON "user" (lower(email), role);--> statement-breakpoint

-- Foreign-key coverage (Postgres does not index referencing columns).
CREATE INDEX booking_order_rentable_idx ON booking_order (rentable_id, created_at DESC);--> statement-breakpoint
CREATE INDEX booking_order_quote_idx ON booking_order (quote_id) WHERE quote_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX booking_quote_customer_idx ON booking_quote (customer_id) WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX booking_quote_rentable_idx ON booking_quote (rentable_id);--> statement-breakpoint
CREATE INDEX review_rentable_public_idx ON review (rentable_id) WHERE author_role = 'customer' AND moderation_state = 'published';--> statement-breakpoint
CREATE INDEX review_author_idx ON review (author_id);--> statement-breakpoint
CREATE INDEX payout_booking_idx ON payout (booking_id);--> statement-breakpoint
CREATE INDEX payout_destination_fk_idx ON payout (destination_id) WHERE destination_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX refund_allocation_booking_idx ON refund_allocation (booking_id);--> statement-breakpoint
CREATE INDEX notification_order_idx ON notification_outbox (order_id);--> statement-breakpoint
CREATE INDEX notification_booking_idx ON notification_outbox (booking_id) WHERE booking_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX support_request_order_idx ON support_request (order_id) WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX support_request_property_idx ON support_request (property_id) WHERE property_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX support_request_assignee_idx ON support_request (assigned_to, state) WHERE assigned_to IS NOT NULL;--> statement-breakpoint
CREATE INDEX support_request_privacy_idx ON support_request (privacy_request_id) WHERE privacy_request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX dispute_case_order_idx ON dispute_case (order_id);--> statement-breakpoint
CREATE INDEX dispute_case_visit_idx ON dispute_case (visit_id);--> statement-breakpoint
CREATE INDEX payment_method_customer_idx ON customer_payment_method (customer_id);--> statement-breakpoint
CREATE INDEX client_update_rentable_idx ON client_update (rentable_id) WHERE rentable_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX client_update_order_idx ON client_update (order_id) WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX rentable_category_idx ON rentable (category_id);--> statement-breakpoint
CREATE INDEX rentable_amenity_amenity_idx ON rentable_amenity (amenity_id);--> statement-breakpoint

-- Hot paths and worker scans.
CREATE INDEX rentable_live_cursor_idx ON rentable (id) WHERE status = 'live';--> statement-breakpoint
CREATE INDEX payment_event_order_ref_idx ON payment_event ((redacted_payload->>'orderId'));--> statement-breakpoint
CREATE INDEX refund_requested_idx ON refund (created_at) WHERE state = 'requested';--> statement-breakpoint
CREATE INDEX admin_export_queue_idx ON admin_export_job (created_at, id) WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX admin_export_artifact_exp_idx ON admin_export_job (expires_at) WHERE artifact_ciphertext IS NOT NULL;--> statement-breakpoint
CREATE INDEX privacy_job_artifact_exp_idx ON privacy_job (expires_at) WHERE artifact_ciphertext IS NOT NULL;--> statement-breakpoint
-- The nearby query casts to geography; a geometry GiST index cannot serve it.
DO $$ BEGIN
  IF to_regtype('geography') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX rentable_location_geog_idx ON rentable USING gist ((location::geography))';
  END IF;
END $$;--> statement-breakpoint

-- Redundant: order_id leads booking_order_position_idx and booking_order_localday_slot_idx.
DROP INDEX booking_order_idx;--> statement-breakpoint

-- A processed event needs no job row; the worker now deletes it on success.
DELETE FROM payment_event_job j USING payment_event e WHERE e.id = j.event_id AND e.state = 'processed';
