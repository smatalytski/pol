# Fiszki — a Polish production trainer

**Date:** 2026-09-12
**Status:** approved design, ready for implementation planning

## 1. Goal

A single-user spaced-repetition app for advancing Polish past the intermediate
plateau. The author reads and converses in Polish and keeps meeting words,
phrases and constructions worth retaining. This app captures them in the moment
and schedules them back.

Two properties drive every decision:

1. **Capture must be nearly free.** Dictating a word while reading should cost
   one gesture and no attention. If capture has friction, nothing gets captured
   and the app is worthless.
2. **Scheduling must be effective.** Review time is the scarce resource, so the
   scheduler is FSRS rather than something hand-rolled, and every rating is
   logged so the parameters can be tuned later against real history.

This is not a product. There is one user, no accounts, no growth path, and no
obligation to scale.

### Non-goals

Offline review. Multi-user accounts. Deck sharing or import. Statistics
dashboards, streaks, gamification. Beginner content — no alphabet drills, no
core-vocabulary decks. Recognition practice (PL→RU); the app trains
*production* only.

**Deferred, not excluded:** a hands-free audio mode (§6) is the next planned
feature. It is not in the first build, but the one decision it constrains —
server-side cached TTS instead of browser speech synthesis — is made now.

## 2. Constraints

- **Primary device:** Android phone, Chrome. Desktop browser used for image
  cards and bulk editing.
- **Languages:** dictation is always Polish. Answers are always Polish. Russian
  appears only as prompt content. UI chrome is Polish.
- **Hosting:** runs on the author's own machine to start, reachable from the
  phone over Tailscale HTTPS. Must be movable to a cloud host later without a
  data migration.
- **Secure context required.** Microphone access, service workers and
  home-screen install all require HTTPS. A bare LAN address over plain HTTP
  would disable the app's central feature, so Tailscale HTTPS is a hard
  requirement rather than a convenience.

## 3. Card model

A card is a prompt and a Polish answer. Three types:

| Type | Prompt | Answer |
|---|---|---|
| `ru_to_pl` | Russian gloss plus a disambiguating hint | the Polish word, phrase or sentence |
| `image_to_pl` | an image | the Polish name for what it shows |
| `pl_forms` | a Polish lemma plus a form request | the conjugation or declension table |

`ru_to_pl` is the default and the overwhelming majority. Every dictation
produces exactly one `ru_to_pl` card — capture stays predictable and the review
queue does not balloon.

`pl_forms` cards are created on demand: a card's detail page has a *dodaj
formy* button that generates the drill for words the author decides deserve it.
They are never generated automatically. A `pl_forms` card records its origin in
`parent_card_id`.

`image_to_pl` cards are created from the desktop upload screen.

### Prompt disambiguation

A bare Russian gloss is frequently ambiguous — «злобный» could elicit
*złośliwy*, *wredny* or *zły*. Single-word `ru_to_pl` prompts therefore carry a
`prompt_hint`: part of speech, and a short Russian context when the gloss alone
is not enough. Sentence prompts need no hint; a Russian sentence pins its Polish
counterpart closely enough.

Grading is by self-assessment, so producing a valid synonym is the author's call
to count as correct. The hint exists to make the prompt answerable, not to force
one exact string.

## 4. Capture

The critical path. `/dodaj` is a near-empty screen with one large circular mic
button.

**The gesture:** press and hold, speak, release. Release ends the recording and
uploads it. There is exactly one way to record — no tap-to-toggle, no second
press, no stop button.

Implementation details that make the gesture feel right:

- `pointerdown` starts recording, `pointerup` / `pointercancel` stops it.
- `touch-action: none` on the button, and the long-press context menu and text
  selection are suppressed.
- A press shorter than 300 ms is discarded as an accidental tap.
- `navigator.vibrate` on start and on stop, so the gesture is confirmed without
  looking at the screen.
- `MediaRecorder` with `audio/webm;codecs=opus`; a few seconds is 10–30 KB.
- The `MediaStream` is acquired once on first press and held for the session, so
  the second and later recordings start instantly.
- A Wake Lock is held while this screen is open, so a dictation session does not
  die when the screen would otherwise lock.

**Feedback.** Each release appends a chip to a list under the button:
*rozpoznawanie…* → the transcript → the finished card. Recording the next word
while the previous is still being processed is expected and does not block; the
pipeline is per-capture and concurrent.

Each chip offers ▶ to replay the audio, tap to expand and edit, and swipe to
delete. **The audio is kept permanently.** When a transcript comes back wrong,
replaying what was actually said is the difference between fixing the card and
losing the word.

**Durability.** The recording is held on the phone (IndexedDB) until the server
confirms it is stored, and upload retries with backoff. This is the only
local-persistence code in the project, and it earns its place: silently losing a
word just encountered is the one failure that would destroy trust in the app.

**Duplicates.** Before creating a card, the normalized answer is looked up. A
re-dictated word shows *już masz* with the existing card instead of creating a
second copy.

### Image capture

`/obrazki`, intended for the desktop browser: drag in several images at once.
Each is downscaled to max 1280 px, re-encoded as WebP (~150 KB), and passed to
the generator, which returns the Polish name and an example sentence. Result is
an `image_to_pl` card.

## 5. Generation

Three services, all called only from server routes so no API key reaches the
browser.

**Transcription.** Whisper (`whisper-large-v3-turbo` via Groq) with
`language: "pl"` pinned — dictation is always Polish, and pinning beats
auto-detection on accuracy. Access goes through a one-function
`transcribe(audio): Promise<string>` interface so the provider can be swapped
for OpenAI's endpoint or a local `whisper.cpp` binary without touching anything
else. Running Whisper locally is attractive given the app already runs on the
author's machine; it is an alternative implementation of the same interface, not
a separate design.

**Card generation.** Claude via structured outputs — `messages.parse()` against
a Zod schema, so the response is schema-valid or an error, never prose to be
parsed. Model comes from `FISZKI_MODEL`, default `claude-opus-5`. Input is the
Polish transcript; output:

```json
{
  "kind": "word | phrase | sentence",
  "answer_pl": "złośliwy",
  "prompt_ru": "злобный, ехидный",
  "prompt_hint": "прилагательное, о человеке",
  "example_pl": "Zrobił to ze złośliwości, nie z głupoty.",
  "example_ru": "Он сделал это из злобы, а не из глупости.",
  "grammar_note": null
}
```

`answer_pl` is a **normalized** Polish form, not the raw transcript. Whisper
mangling diacritics is the expected common case, so the generator is explicitly
responsible for correcting spelling and restoring the dictionary form where the
dictated word was inflected mid-sentence.

For `pl_forms`, a second prompt returns a compact form table as Markdown.

The raw model response is stored on the capture row for debugging and
regeneration.

**Speech synthesis.** Cards are spoken by **server-side TTS, cached as blobs**,
not by the browser's `SpeechSynthesis`. This is a deliberate choice made in the
first build even though only the 🔊 button needs it at first: `speechSynthesis`
on Android Chrome stops when the screen locks or the tab backgrounds, which
would make the planned audio mode impossible. Building it server-side once
serves both, with no rework.

Access goes through `speak(text, lang): Promise<mediaId>`, backed by Google
Cloud TTS (`pl-PL` and `ru-RU` neural voices, one pinned voice per language).
As with transcription, a local implementation — Piper, which has good Polish and
Russian voices and runs on the same machine — satisfies the same interface at
zero cost.

Clips are content-addressed by `sha256(text | lang | voice)` and generated once.
A card's Russian prompt and Polish answer are synthesized the first time either
is needed and reused forever after; editing a card's text simply yields a new
key.

## 6. Review

`/` redirects to `/powtorki`. Opening the app puts you straight into reviewing —
no menu, no dashboard.

**Front:** the Russian prompt in large type with its hint beneath, or the image,
or the Polish form request. One button: *pokaż*.

**Back:** the Polish answer in large type, then the example sentence and grammar
note, and a 🔊 that plays the cached Polish audio for the answer. Hearing it
matters when the goal is production.

**Rating:** four buttons, thumb-reachable at the bottom — *nie pamiętam / z
trudem / dobrze / łatwo*, mapping to FSRS `Again / Hard / Good / Easy`. Four
rather than three because FSRS must distinguish a failed recall from a
successful but effortful one; those require opposite scheduling, and collapsing
them means either forgetting material or re-reviewing known material.

**Undo** reverts the last rating and restores the previous scheduler state. A
mistaken *łatwo* otherwise hides a card for a month.

**Queue construction.** Due cards (`due <= now`, not suspended, status `ready`)
sorted by `due` ascending, with new cards interleaved up to the daily cap
(default 10, stored in settings). New cards are spaced evenly through the
session rather than front-loaded: the interleave stride is
`max(2, floor(due_count / new_count))`. The cap exists so an hour of dictating
while reading does not bury the next morning.

Cards introduced today are counted as reviews whose `state_before.state` is
`New`, which keeps the cap correct across multiple sessions in a day.

**Session end:** a count of what was reviewed and when the next card comes due.

**Desktop keys:** space reveals, `1`–`4` rate, `z` undoes.

### Audio mode — planned, not in the first build

A hands-free mode for walking, commuting or dishes: the Russian prompt plays,
about five seconds of silence follow, then the Polish answer.

**Passive exposure only. It records nothing and changes no schedule.** The FSRS
history stays composed purely of deliberate, rated, on-screen reviews, so no
half-guess made while walking can corrupt an interval. The benefit is
repetition; real reviews still happen on screen.

**Per-card sequence:** Russian prompt → 5 s silence (configurable) → Polish
answer → 1 s → Polish answer again. Repeating the answer is worth the seconds
when the goal is production rather than recognition.

**Only `ru_to_pl` cards participate.** An image has no audible prompt, and a
declension table read aloud is noise.

**Background playback is the whole point, so timing must not depend on
JavaScript.** Backgrounded tabs get their timers throttled, which would wreck a
five-second gap. Instead the server assembles **one audio file per card** —
prompt, real silence, answer, silence, answer — and the client plays a playlist
of those files through a single `<audio>` element, advancing on `ended`. Media
playback and its `ended` event are reliable with the screen off; `setTimeout` is
not. The Media Session API supplies lock-screen metadata and play/pause/skip.

**Selection:** due cards first, then recently lapsed ones, capped by a session
length in minutes rather than a card count, since the point is to fill a walk.

Concatenation is per card rather than per session so that skip works and so that
a card edited mid-session invalidates only its own file.

## 7. Scheduling

`ts-fsrs`, wrapped in a thin module that is the only place scheduler state is
computed. It takes a card's stored FSRS fields plus a rating and returns the new
fields — a pure function over data, and therefore directly unit-testable.

Target retention defaults to 0.9 and lives in settings.

Every review is written to an append-only `reviews` table with a JSON snapshot
of the pre-review scheduler state. This costs nothing now and means FSRS
parameters can later be optimized against real history rather than guessed at,
and that a scheduler bug can be recovered from by replaying the log.

## 8. Data model

One SQLite file. **All media — images and audio — lives in the database as
blobs**, so the entire application state is a single file that can be copied.

Blobs live in their own table. SQLite reads by page, so a blob column inside
`cards` would drag megabytes of image data through memory on every scan of the
due queue; separated, the cost is zero.

```sql
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
```

Duplicate detection is application-level against `answer_key`, not a unique
constraint — re-dictating a word should surface the existing card, not raise an
error.

`answer_key` normalization: lowercase, trim, collapse whitespace, strip
punctuation. Diacritics are **preserved** — *łaska* and *laska* are different
words.

## 9. API surface

| Route | Purpose |
|---|---|
| `POST /api/captures` | multipart audio in; stores the blob, returns `{captureId}` immediately, runs the pipeline after responding |
| `GET /api/captures?since=` | status of recent captures, polled while any are pending |
| `POST /api/captures/:id/retry` | re-run transcription and generation for a failed capture |
| `GET /api/review/queue` | the session's ordered card batch |
| `POST /api/review/:cardId` | `{rating, durationMs}` → logs the review, advances the scheduler |
| `POST /api/review/undo` | revert the last review |
| `POST /api/cards` | create a card manually |
| `PATCH /api/cards/:id` | edit fields, suspend, unsuspend |
| `DELETE /api/cards/:id` | delete, cascading its reviews |
| `POST /api/cards/:id/formy` | generate the `pl_forms` child card |
| `POST /api/images` | multipart images in, `image_to_pl` cards out |
| `GET /api/cards/:id/audio?part=answer` | the cached TTS clip for a card's Polish answer or Russian prompt, synthesizing it on first request |
| `GET /api/media/:id` | serve a blob with an ETag and a long `max-age`; media is immutable so each is fetched once |
| `POST /api/login` | passphrase in, session cookie out |

Capture status is polled rather than streamed. For one user with a handful of
in-flight captures, a 1-second poll while anything is pending is simpler than
SSE and indistinguishable in practice.

## 10. Stack and deployment

- **Next.js 15** (App Router), TypeScript, React 19 — one repo, one process.
- **SQLite** via `better-sqlite3` and **Drizzle** for typed schema and
  migrations. WAL mode.
- **Tailwind** for UI; mobile-first, large tap targets.
- **`ts-fsrs`** for scheduling.
- **PWA:** a manifest with `display: standalone` and `start_url: /powtorki`,
  plus a minimal service worker with a passthrough fetch handler — required for
  Chrome to offer home-screen install. It caches the app shell only; there is no
  offline data.
- **Auth:** a single passphrase from `APP_PASSWORD`, exchanged for an HMAC-signed
  httpOnly cookie with a long expiry. Middleware guards everything except the
  login route. Tailscale already keeps the app off the public internet; the
  passphrase means a lost phone is not instant access.
- **Access:** `tailscale serve --bg https / http://localhost:3000`, giving a
  real certificate on a `*.ts.net` hostname.
- **Cloud move, when it happens:** the same container deploys to Fly.io with a
  volume for the SQLite file. No schema change, no media migration, because
  media is already in the database. Nothing in the app knows where it runs.

Repository layout:

```
app/            routes and screens
  powtorki/     review
  dodaj/        voice capture
  obrazki/      image upload
  fiszki/       browse and edit
  api/
lib/
  db/           schema, migrations, queries
  scheduler/    ts-fsrs wrapper
  generate/     Claude card generation
  transcribe/   Whisper interface + providers
  tts/          speech synthesis interface + providers + clip cache
  media/        image downscale/encode
i18n/pl.ts      every UI string
scripts/backup.sh
data/fiszki.db
```

## 11. Failure handling

Each failure degrades to something that never costs a captured word.

| Failure | Behaviour |
|---|---|
| Upload fails | recording stays on the phone, retries with backoff; chip shows *wysyłanie…* |
| Transcription fails | capture marked `failed`, audio retained, chip offers retry |
| Generation fails | the card is still created with the transcript as its answer and no Russian prompt, status `needs_input`, flagged in the browse screen |
| Transcript wrong | replay the audio, edit the text by hand |
| Wrong diacritics | expected; the generator returns a normalized form rather than trusting the transcript |
| LLM unreachable entirely | capture still works end to end; cards land as `needs_input` |
| Mic permission denied | an explanatory screen, since the app is unusable without it |

## 12. Testing

Vitest. Tests go where a silent bug would quietly cost months of learning:

- **Scheduler wrapper** — a pure function over data. Each rating from each
  state, interval monotonicity, lapse handling, undo restoring exact prior
  state.
- **Queue construction** — due ordering, the new-card cap across multiple
  sessions in one day, the interleave stride, exclusion of suspended and
  non-`ready` cards.
- **`answer_key` normalization and duplicate detection** — including that
  diacritics are not stripped.
- **Generation parsing** — recorded transcripts in, expected card shape out, on
  fixtures rather than live API calls. Includes malformed-response handling.
- **Capture retry path** — upload failure followed by success creates exactly
  one card.
- **TTS clip cache** — the same text yields one clip and one synthesis call;
  editing a card's text yields a new key and leaves the old clip untouched.

No browser E2E suite. There is one user, and he is the end-to-end test.

## 13. Backup

`scripts/backup.sh` runs `VACUUM INTO 'backup-YYYY-MM-DD.db'` — a consistent
snapshot taken while the app is running, which a plain file copy is not. One
file contains cards, review history, images and audio.
