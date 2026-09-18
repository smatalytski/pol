-- Recording language (docs/superpowers/specs/2026-09-18-recording-language-design.md §4).
-- Append-only: the deployed database holds real cards.

-- The language the recording was made in, chosen by the button held on /dodaj:
-- 'pl' | 'ru'. NULL for every recording made before this migration, which
-- were all recognised as Polish, so NULL means 'pl'.
ALTER TABLE captures ADD COLUMN lang TEXT;

-- Re-recognition is removed along with its 'rerecognized' job kind. A job of
-- that kind still waiting or running would reach a worker with no handler
-- for it, so it ends here. Finished ones stay as history.
UPDATE generation_jobs
   SET status = 'failed',
       last_error = 're-recognition removed',
       finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE kind = 'rerecognized' AND status IN ('queued', 'running');
