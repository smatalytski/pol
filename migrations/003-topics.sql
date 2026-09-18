-- Topics (docs/superpowers/specs/2026-09-18-topic-generation-design.md §3).
-- Append-only: the deployed database holds real cards. Every change here is
-- additive, and every new column on an existing table is nullable.

-- A situation you asked vocabulary for. Its cards can be switched off as a
-- whole via suspended_at, independently of each card's own suspended_at.
CREATE TABLE topics (
  id            TEXT PRIMARY KEY,
  name          TEXT,              -- NULL until the first round names it
  context       TEXT NOT NULL,
  suspended_at  INTEGER,
  created_at    INTEGER NOT NULL
);

-- Every item ever proposed for a topic, kept so later rounds never repeat one.
CREATE TABLE suggestions (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  round       INTEGER NOT NULL,
  answer_pl   TEXT NOT NULL,
  gloss_ru    TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- 'slowo' | 'fraza'
  status      TEXT NOT NULL,       -- 'proposed' | 'accepted' | 'rejected'
  -- The capture an accepted item became. SET NULL: a capture with no card can
  -- be hard-deleted, and that must not be blocked by, or dangle from, this row.
  capture_id  TEXT REFERENCES captures(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX suggestions_topic_round ON suggestions(topic_id, round);

ALTER TABLE cards ADD COLUMN topic_id TEXT REFERENCES topics(id);

-- An accepted suggestion becomes a capture with no audio; these two carry
-- its topic and the Russian meaning the card should be built around.
ALTER TABLE captures ADD COLUMN topic_id TEXT REFERENCES topics(id);
ALTER TABLE captures ADD COLUMN gloss_ru TEXT;

-- For kind 'suggest': the topic, and {"round","count","mix"}.
ALTER TABLE generation_jobs ADD COLUMN topic_id TEXT REFERENCES topics(id);
ALTER TABLE generation_jobs ADD COLUMN params_json TEXT;
