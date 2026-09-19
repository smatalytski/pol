-- Hands-free listening (docs/superpowers/specs/2026-09-19-hands-free-audio-design.md §3).
-- Append-only: the deployed database holds real cards.

-- One assembled MP3 per (spoken texts, voices, sequence settings, assembly
-- version). Content-addressed: editing a card or changing a setting makes a
-- new key, and the old row is simply never looked up again.
CREATE TABLE card_audio (
  key          TEXT PRIMARY KEY,
  media_id     TEXT NOT NULL REFERENCES media(id),
  duration_ms  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Every time a card's audio played to its end in a listening session. Drives
-- rotation only; the scheduler and the review queue never read it.
CREATE TABLE listens (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id   TEXT NOT NULL REFERENCES cards(id),
  heard_at  INTEGER NOT NULL
);
CREATE INDEX listens_card ON listens(card_id, heard_at);
