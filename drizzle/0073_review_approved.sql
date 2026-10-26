-- Story 2.1: a reviewer may approve a submission directly; verification visits stay optional.
-- 'approved_for_visit' remains for existing records that still require a passed visit.
ALTER TYPE listing_review_outcome ADD VALUE IF NOT EXISTS 'approved';
