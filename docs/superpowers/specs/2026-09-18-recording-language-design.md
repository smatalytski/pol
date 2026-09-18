# Fiszki — the language is chosen when recording; re-recognition is removed

Date: 2026-09-18
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-09-18-generation-queue-design.md` and
`2026-09-18-topic-generation-design.md`.
Supersedes: the queue spec's `po polsku · po rosyjsku` controls (§3, §7.1, §7.3),
its `rerecognized` job kind (§5), and `POST /api/captures/:id/jezyk` (§8).

## 1. What changes, in one paragraph

Every recording is recognised as Polish today, and a Russian word is fixed
afterwards by re-recognising its audio: on the chip during the 10-second window,
or later on the card page. Instead, `/dodaj` gets two hold-to-record buttons,
**PL** and **RU**. The button you hold decides the recognition language. It is
stored with the recording and used for every recognition of it. Re-recognition
disappears everywhere: a recording in the wrong language is rejected with
`usuń` and recorded again.

## 2. Recording

- `/dodaj`'s single `przytrzymaj i mów` button becomes two buttons side by side,
  **PL** and **RU**. They use the same hold gesture, and the one being held turns red.
- The language goes with the recording end to end:
  - the outbox entry in IndexedDB gains `lang: 'pl' | 'ru'`;
  - `POST /api/captures` takes a multipart field `lang`;
  - the capture row stores it.
- `POST /api/captures` accepts `lang` of `pl` or `ru`. A missing `lang` means
  `pl`, so an outbox entry saved before this change still uploads. Any other
  value is refused with 400 and nothing is stored.
- Every recognition of a capture uses its stored language: the first one,
  `ponów` after a recognition failure, and `recognizeStranded` after a restart.
  A capture whose stored language is null means `pl`: that is what every older
  recording was recognised as.

## 3. Removing re-recognition

- **Chip (`/dodaj`):** the `rozpoznaj po polsku · po rosyjsku` controls are
  removed. An under-review chip offers only `usuń`.
- **Card page (`/fiszki/[id]`):** the re-recognition controls are removed, and
  `GET /api/cards/:id` no longer returns `captureId`.
- **Server:** these are deleted with their tests:
  - the route `POST /api/captures/:id/jezyk`;
  - `rerecognize`, `applyRerecognized`, `giveUpRerecognized` and `creatorCaptureId`;
  - the `rerecognized` job kind and its handler.
- **Strings:** `recognizeAs` and `languageFailed` are removed from `i18n/pl.ts`.
  `asPolish` and `asRussian` stay: `/tematy/nowy` uses them for dictating a
  topic's context.
- **`już masz`:** unchanged. The recognition-time check already matches a
  Cyrillic transcript against a card's Russian prompt.

## 4. Data

A new append-only `migrations/004-capture-lang.sql`:

- `captures.lang TEXT`, nullable. Null means `pl`, and existing rows keep null.
- Any `generation_jobs` row with kind `rerecognized` and status `queued` or
  `running` becomes `failed`, with `last_error = 're-recognition removed'` and
  `finished_at` set. Without this, the worker would pick up a job kind it no
  longer has a handler for. Finished `rerecognized` rows stay as history.
  `JobKind` no longer lists `rerecognized`, but nothing reads the old rows'
  kind any more.

## 5. Verification

Unit tests, test-first:

- **Pipeline:**
  - a capture uploaded as `ru` is transcribed with `lang: 'ru'`, one uploaded as `pl` with `lang: 'pl'`;
  - `ponów` and `recognizeStranded` reuse the stored language;
  - a null language is recognised as `pl`.
- **Route:** `POST /api/captures` stores `lang`, a missing `lang` means `pl`, and an unknown one is refused with 400.
- **Outbox:** an entry keeps its `lang` through `enqueue`/`flush`, and one without `lang` uploads as `pl`.
- **Screens:**
  - holding RU enqueues an `ru` recording, and PL a `pl` one;
  - the chip has no language controls;
  - the card page has no re-recognition controls.
- **Migration:** an upgrade from a database with 003 applied adds `captures.lang` and fails a queued `rerecognized` job, leaving done ones as they were.
- **Queue:** no job kind `rerecognized` remains in `JobKind` or the handlers.

**At deploy:** the usual backup and fresh-tree swap, with no database drop.
Then on the phone, hold RU and say a Russian word, hold PL and say a Polish
one, and check that both become correct cards.

## 6. Out of scope

- Automatic language detection. The two buttons replace it.
- Choosing the language of a topic's dictated context. `/tematy/nowy` keeps its
  own `po rosyjsku · po polsku` toggle.
