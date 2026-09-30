-- Performance: the review-score refresh only matters when a visit enters or leaves 'completed'
-- (rentra_review_eligible requires state='completed'). It used to recount on every state change.
DROP TRIGGER review_visit_refresh ON booking;--> statement-breakpoint
CREATE TRIGGER review_visit_refresh AFTER UPDATE OF state ON booking FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND (OLD.state = 'completed' OR NEW.state = 'completed'))
  EXECUTE FUNCTION rentra_review_refresh();
