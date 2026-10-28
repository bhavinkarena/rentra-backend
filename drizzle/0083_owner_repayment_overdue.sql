-- Story 2.20: Test-only owner-wide booking restriction while a received repayment notice is past due_at
-- and its recovery still has an outstanding balance. Derived, never stored; clears only on settlement.
CREATE FUNCTION owner_repayment_overdue(owner uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM owner_repayment_notice n JOIN owner_recovery r ON r.id=n.recovery_id
    WHERE n.owner_id=owner AND n.due_at<=now() AND r.obligation_minor-r.recovered_minor>0)
$$;
--> statement-breakpoint
CREATE FUNCTION rentra_booking_order_owner_overdue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF owner_repayment_overdue((SELECT client_id FROM rentable WHERE id=NEW.rentable_id)) THEN
    RAISE EXCEPTION 'OWNER_REPAYMENT_OVERDUE' USING ERRCODE='RN001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_order_owner_overdue BEFORE INSERT ON booking_order
  FOR EACH ROW EXECUTE FUNCTION rentra_booking_order_owner_overdue();
