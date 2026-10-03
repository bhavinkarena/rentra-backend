-- BOOK-08: the arrival guide reaches the guest through the customer SMS outbox (T-24h and arrival morning, IST).
ALTER TABLE notification_outbox DROP CONSTRAINT notification_valid_chk;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_valid_chk CHECK ("notification_outbox"."template" IN ('confirmation','reminder','cancellation','refund','completion','review_invitation','arrival_guide')
    AND "notification_outbox"."channel"='sms' AND "notification_outbox"."attempts">=0 AND "notification_outbox"."state" IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed'));
