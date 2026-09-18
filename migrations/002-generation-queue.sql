-- Generation queue (docs/superpowers/specs/2026-09-18-generation-queue-design.md
-- §9). Append-only again: the one-time squash of 2026-09-18 does not repeat,
-- because the deployed database now holds real cards.

-- When the transcript arrived: the start of the 10-second review window (§3).
ALTER TABLE captures ADD COLUMN transcribed_at INTEGER;

-- The card a transcript already matches at recognition time (§4): the chip's
-- "już masz". A recording approved with this set becomes 'duplicate' and is
-- never queued.
ALTER TABLE captures ADD COLUMN duplicate_of TEXT REFERENCES cards(id);

-- A recording caught mid-pipeline by this upgrade is 'transcribed' with no
-- review timestamp. Stamping it with its upload time puts it under the review
-- rule, which approves it on the worker's first tick (it is long past 10 s).
UPDATE captures SET transcribed_at = created_at WHERE status = 'transcribed';

CREATE TABLE generation_jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,     -- 'new' | 'regenerate' | 'rerecognized'
  -- ON DELETE CASCADE: rejecting a recording hard-deletes its row, and its job
  -- goes with it.
  capture_id       TEXT REFERENCES captures(id) ON DELETE CASCADE,
  card_id          TEXT REFERENCES cards(id),
  status           TEXT NOT NULL,     -- 'queued' | 'running' | 'done' | 'failed'
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);

CREATE INDEX generation_jobs_due ON generation_jobs(status, next_attempt_at);
