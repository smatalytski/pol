CREATE TABLE media (
  id          TEXT PRIMARY KEY,   -- uuid
  kind        TEXT NOT NULL,      -- 'image' | 'audio' | 'tts'
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE cards (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,   -- 'ru_to_pl' | 'image_to_pl' | 'pl_forms'
  prompt_text     TEXT,            -- RU gloss, or PL form request; NULL for image cards
  prompt_hint     TEXT,
  prompt_media_id TEXT REFERENCES media(id),
  answer_pl       TEXT NOT NULL,
  answer_key      TEXT NOT NULL,   -- normalized answer, for duplicate detection
  example_pl      TEXT,
  example_ru      TEXT,
  grammar_note    TEXT,
  status          TEXT NOT NULL DEFAULT 'ready',
                                   -- 'ready' | 'needs_input'
                                   -- a card row is created only after generation
                                   -- resolves; in-flight state lives on `captures`
  parent_card_id  TEXT REFERENCES cards(id),
  suspended_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  -- FSRS state, inline so the due query stays indexable
  due             INTEGER NOT NULL,
  stability       REAL    NOT NULL DEFAULT 0,
  difficulty      REAL    NOT NULL DEFAULT 0,
  elapsed_days    INTEGER NOT NULL DEFAULT 0,
  scheduled_days  INTEGER NOT NULL DEFAULT 0,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  state           INTEGER NOT NULL DEFAULT 0,
  last_review     INTEGER
);

-- `needs_input` cards are excluded from review until their prompt is filled in
CREATE INDEX cards_due ON cards(due)
  WHERE suspended_at IS NULL AND status = 'ready';
CREATE INDEX cards_answer_key ON cards(answer_key);

CREATE TABLE reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating        INTEGER NOT NULL,   -- 1..4, FSRS Again..Easy
  reviewed_at   INTEGER NOT NULL,
  duration_ms   INTEGER,
  state_before  TEXT NOT NULL,      -- JSON snapshot of the FSRS fields
  undone_at     INTEGER
);

CREATE INDEX reviews_card ON reviews(card_id, reviewed_at);

CREATE TABLE captures (
  id              TEXT PRIMARY KEY,
  audio_media_id  TEXT REFERENCES media(id),
  transcript      TEXT,
  status          TEXT NOT NULL,    -- 'uploaded' | 'transcribed' | 'generated' | 'failed'
  error           TEXT,
  generation_json TEXT,
  card_id         TEXT REFERENCES cards(id),
  created_at      INTEGER NOT NULL
);

-- content-addressed TTS cache; generated once per distinct text, reused forever
CREATE TABLE tts_clips (
  id          TEXT PRIMARY KEY,   -- sha256(text | lang | voice)
  media_id    TEXT NOT NULL REFERENCES media(id),
  lang        TEXT NOT NULL,      -- 'pl' | 'ru'
  voice       TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
