-- Soft delete for cards (spec §7/§9, decided 2026-09-16): a deleted card must
-- vanish from every query while its `reviews` history survives, since that
-- history is what lets FSRS parameters be optimized later and a scheduler bug
-- be recovered from by replay. A hard delete would destroy that on purpose.
ALTER TABLE cards ADD COLUMN deleted_at INTEGER;
