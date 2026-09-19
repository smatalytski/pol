-- Topic items (docs/superpowers/specs/2026-09-19-topic-items-design.md §3).
-- Append-only: the deployed database holds real cards.

-- The default topic. Every card belongs to a topic from now on; dictations
-- from /dodaj and hand-typed cards land here. It cannot be generated for.
ALTER TABLE topics ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
INSERT INTO topics (id, name, context, suspended_at, created_at, is_default)
VALUES ('default', 'Ogólne', '', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 1);
UPDATE cards SET topic_id = 'default' WHERE topic_id IS NULL;

-- Everything in a topic that is not a live card: suggestions, hand-added
-- items, discarded ones, and converted ones kept so a batch never repeats
-- them. Rebuilt rather than altered: SQLite cannot drop NOT NULL from
-- suggestions.gloss_ru.
CREATE TABLE topic_items (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  answer_pl     TEXT NOT NULL,
  gloss_ru      TEXT,
  kind          TEXT,              -- 'slowo' | 'fraza' | NULL (hand-added)
  source        TEXT NOT NULL,     -- 'suggested' | 'manual'
  level         TEXT,              -- 'zaawansowany' | 'sredni' | NULL (hand-added)
  status        TEXT NOT NULL,     -- 'open' | 'discarded' | 'carded'
  capture_id    TEXT REFERENCES captures(id) ON DELETE SET NULL,
  card_id       TEXT REFERENCES cards(id),
  batch_job_id  TEXT,              -- the suggest job that proposed it
  discarded_at  INTEGER,
  created_at    INTEGER NOT NULL
);

INSERT INTO topic_items (id, topic_id, answer_pl, gloss_ru, kind, source, level, status,
                         capture_id, card_id, batch_job_id, discarded_at, created_at)
SELECT s.id, s.topic_id, s.answer_pl, s.gloss_ru, s.kind, 'suggested', 'zaawansowany',
       CASE s.status WHEN 'proposed' THEN 'open' WHEN 'rejected' THEN 'discarded' ELSE 'carded' END,
       s.capture_id, c.card_id, NULL,
       CASE s.status WHEN 'rejected' THEN s.created_at END,
       s.created_at
  FROM suggestions s LEFT JOIN captures c ON c.id = s.capture_id;

DROP TABLE suggestions;

CREATE INDEX topic_items_topic_status ON topic_items(topic_id, status);
CREATE INDEX topic_items_capture ON topic_items(capture_id);
