-- Hotel plan, Phase 5: a stay's rooms follow its booking. Every path that cancels a booking (guest,
-- admin case, hold expiry) releases the rooms; a no-show or a completed stay records it on the rooms.
-- booking_room triggers (0064) then update room_night counts. Text comparison only (55P04 rule).
CREATE FUNCTION booking_room_follow_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state::text = 'cancelled' THEN
    UPDATE booking_room SET state = 'released', updated_at = now() WHERE booking_id = NEW.id AND state IN ('held', 'booked');
  ELSIF NEW.state::text = 'no_show' THEN
    UPDATE booking_room SET state = 'no_show', updated_at = now() WHERE booking_id = NEW.id AND state = 'booked';
  ELSIF NEW.state::text = 'completed' THEN
    UPDATE booking_room SET state = 'stayed', updated_at = now() WHERE booking_id = NEW.id AND state = 'booked';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER booking_room_follow_booking AFTER UPDATE OF state ON booking
  FOR EACH ROW WHEN (NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION booking_room_follow_booking();
