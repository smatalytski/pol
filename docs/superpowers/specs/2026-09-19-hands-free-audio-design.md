# Fiszki — hands-free listening

Date: 2026-09-19
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-09-12-polish-srs-design.md` §6 "Audio mode", which planned this.
Its decisions stand except where this spec changes them:
- rotation via a listening log (§3.4);
- a session drawn from topics (§4.1);
- an optional example sentence (§3.2);
- MP3 files built with ffmpeg (§3.3).

## 1. What changes, in one paragraph

A new tab, **Słuchaj**, plays a listening session you can follow with the screen locked and off. For each card the phone plays:
1. the Russian prompt;
2. a thinking pause;
3. the Polish answer, optionally a second time;
4. optionally the Polish example sentence.

Each card's sequence, silences included, is one MP3 built on the server with ffmpeg, so timing never depends on JavaScript. A session lasts a chosen number of minutes and draws from all active cards or from chosen topics. It plays today's due cards first, then the cards heard longest ago or never heard. Listening is **passive**: it is recorded only in a separate listening log that drives the rotation, and it never touches the review schedule. Lock-screen and headphone controls work through the Media Session API. **Android only for now.**

## 2. Decisions

- **Platform:** Android (Chrome, home-screen app). iOS is out of scope.
- **Passive:** no ratings, no FSRS changes, no rows in `reviews`.
- **Rotation:**
  - a `listens` log;
  - selection orders due-today cards first, then never-heard, then least recently heard.
- **Card scope:**
  - by default, every eligible card;
  - an optional multi-select of switched-on topics.
- **Session length:** in minutes, 10 / 20 / 30 / 45. More cards are fetched while you listen.
- **Per-card sequence** (§3.2): the pause, the answer repeat and the example are configurable; the small gaps are fixed.
- **MP3 via ffmpeg** on the server, to keep mobile data low. ffmpeg becomes a system dependency on the VM.

## 3. Audio

### 3.1 Eligible cards

A card can be played when all of these hold:
- `type = 'ru_to_pl'`;
- `status = 'ready'`, and it is not deleted or suspended;
- its topic is switched on;
- it has non-empty `prompt_text`.

This is the review queue's `REVIEWABLE` rule plus the non-empty prompt, so a switched-off topic or a suspended card never plays.

### 3.2 The sequence

```
RU: prompt_text [+ ". " + prompt_hint when audioHint and prompt_hint is non-blank]
silence: audioGapSeconds            (setting, 1–30 s, default 5)
PL: answer_pl
[if audioRepeatAnswer]  silence 1 s, PL: answer_pl          (default on)
[if audioExample and example_pl]  silence 1 s, PL: example_pl  (default on)
  [if also audioRepeatExample]  silence 1 s, PL: example_pl     (default on)
silence: audioNextSeconds           (setting, 1–30 s, default 5)
```

- The trailing `audioNextSeconds` sits inside each card's file, so moving to the next card needs no timer.
- Every spoken text (the RU prompt, the hint, the PL answer, the example) passes through `speakable()` first (`lib/audio/sequence.ts`), which turns a slash and any surrounding whitespace into `, ` — a slash written to separate alternatives (`седоватый / с проседью`) is never read aloud. The review screen's own audio route (`app/api/cards/[id]/audio/route.ts`) applies the same normalization before calling `getClip`.
- The example's Russian translation is never spoken.
- Voices are the existing ones: `ru-RU-Chirp3-HD-Kore` and `pl-PL-Chirp3-HD-Kore`.

### 3.3 Assembly and caching

- **Clips** come from the existing content-addressed TTS cache (`getClip` in `lib/tts`), one per spoken text and language. Nothing about clip caching changes.
- **`lib/audio/card-audio.ts`** exposes `buildCardAudio(deps, card, settings)`.
- **The encoder** is injected (`Encoder`): it takes an ordered list of parts (`{ clip: bytes } | { silenceMs }`) and returns one MP3.
  - The production encoder runs ffmpeg once per card, writing the clips to a temp dir. It makes the silences with `anullsrc`, concatenates the parts, and encodes mono, 24 kHz, 64 kbps.
  - The temp dir is removed afterwards, whether the build succeeded or not.
- **Cache:** the result is stored as a `media` row (kind `listen`), in a new table `card_audio (key PRIMARY KEY, media_id, duration_ms, created_at)`.
  - `key` is a SHA-256 of the spoken texts, the voices, the five settings and an assembly version number.
  - Editing a card or changing a setting produces a new key, and the next play builds a fresh file.
  - Old entries are never looked up again. Cleaning them up is out of scope.
- **Duration** is read from ffmpeg's output and stored. It feeds the session planning.
- **If ffmpeg is missing** (`ENOENT`), the audio endpoint answers 503 with `{ error: 'ffmpeg missing' }`. The server does not crash.

### 3.4 The listening log

- **Table:** `listens (id INTEGER PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), heard_at INTEGER NOT NULL)`, indexed on `(card_id, heard_at)`.
- **When a row is written:** a card counts as heard only once its file has **played to its end**. A skipped card or a stopped session writes nothing.
- **Isolation:** `listens` is never read by the scheduler, the review queue or the statistics.

### 3.5 Settings

- `audioGapSeconds` already exists (1–30). It is now the thinking pause.
- New: `audioRepeatAnswer` and `audioExample`, stored as `1` / `0`, both defaulting to `1`.
- New: `audioHint`, stored as `1` / `0`, defaulting to `0` — the Russian prompt is spoken alone unless turned on.
- New: `audioRepeatExample`, stored as `1` / `0`, defaulting to `1` — has no effect when `audioExample` is off or the card has no example.
- New: `audioNextSeconds`, an integer 1–30, defaulting to `5` — the trailing pause before the next card, replacing the old fixed 2 s.
- `PUT /api/settings` accepts them.

Migration `006-listening.sql` (append-only) creates `card_audio` and `listens`. Settings need no schema change: they are key/value rows.

Migration `007-prompt-commas.sql` (append-only, part D below) is a one-time
data cleanup, not a schema change: it rewrites existing `cards.prompt_text`
values so a slash between alternatives becomes a comma, matching the
generator's new rule (§3.2) and what `speakable()` already does at speak
time. It touches no other column.

## 4. Sessions

### 4.1 Planning — `POST /api/listen/session`

- **Body:** `{ minutes: 10|20|30|45, topicIds?: string[], excludeIds?: string[] }`.
- **Returns:** `{ cards: { id, promptText, topicName, estimatedMs, audioKey }[] }`. `audioKey` is the card's current audio cache key (§3.3) at planning time — the client passes it back to §4.2's `?k=` so that route can tell whether its own answer is still current.
- **Which cards:**
  - Eligible cards (§3.1), limited to `topicIds` when given; any switched-off topic in the list is ignored.
  - Minus `excludeIds`.
- **Ordering:**
  1. review cards due by the end of today (local time), least recently heard first;
  2. then all others: never heard first, then least recently heard;
  3. ties broken by `due`, then by id.
- **Time budget:** cards are taken in that order until the sum of `estimatedMs` reaches `minutes`.
  - `estimatedMs` is `card_audio.duration_ms` when the card's current key is cached.
  - Otherwise it is estimated as 60 ms per character of spoken text, plus the silences.
- **Top-ups:** the client asks again with `excludeIds` (every card of the session so far) and `minutes` (what's left), and gets the next cards in the same order.

### 4.2 Audio — `GET /api/listen/cards/:id/audio?k=<audioKey>`

- **On success:** always builds (or reuses) and returns the card's CURRENT audio (§3.3), as `audio/mpeg`. The bytes change whenever the card is edited or a listening setting changes, so the URL alone is never a stable cache key — `?k=` states which key the caller expects (normally the `audioKey` from its §4.1 plan):
  - `k` equals the key just built: the URL and that key genuinely name the same bytes right now, so the response is `Cache-Control: private, max-age=31536000, immutable` with `ETag: "<key>"`.
  - `k` is missing or differs (the card or a setting changed since the plan was made): the current audio is still served, but `Cache-Control: no-store`, so a client holding a stale URL never caches the new bytes under it.
- **Errors:**
  - 404 for a card that is unknown or not eligible;
  - 503 when ffmpeg is missing;
  - 502 when TTS fails. A 429 counts as a TTS failure: the client skips the card.

### 4.3 Heard — `POST /api/listen/heard`

- **Body:** `{ cardId }`. It inserts a `listens` row with the server's time and returns 204.
- **Errors:** 404 for an unknown card.

## 5. The screen — `/sluchaj`

**Navigation:** the tab **Słuchaj** sits between **Powtórki** and **Dodaj**.

### 5.1 Before starting

- **Length:** `10 · 20 · 30 · 45 min`. The last choice is remembered in the browser.
- **Topics:** `wszystkie` or a multi-select of switched-on topics, with Ogólne included.
- **Sequence line:** the current sequence in words, e.g. `przerwa 5 s · następna 5 s · odpowiedź ×2 · przykład`, linking to `/ustawienia`.
- **Start:** a `Start` button.

### 5.2 Playing

- **Playback:**
  - One `<audio>` element plays the current card's file, fetched as `/api/listen/cards/:id/audio?k=<audioKey>` (the card's own `audioKey` from the plan — §4.2's cache headers turn on only when this matches).
  - The next card's file is prefetched the same way (`fetch` into a blob URL) while the current one plays.
  - On `ended`: post `heard`, then play the next file. When fewer than three cards remain, top up (§4.1).
  - The session ends when the played time reaches the chosen minutes or the list runs out.
- **Visible:** the Russian prompt and topic of the current card, `n / N`, minutes left, and the buttons `⏸`/`▶`, `⏭` (skip) and `Stop`.
- **Media Session:**
  - Metadata: title = the Russian prompt, artist = `Fiszki`, album = the topic name.
  - Actions:
    - `play`/`pause`;
    - `nexttrack` skips, without marking the card heard;
    - `previoustrack` replays the current card from the start;
    - `stop` ends the session.
- **Nothing timer-driven:** no JavaScript timer drives playback, and no wake lock is taken. The screen may turn off.
- **Failures:**
  - A card whose audio request fails is skipped.
  - Three failures in a row stop the session with `nie udało się odtworzyć` (couldn't play) and the last error.
- **End:** `Koniec — przesłuchano n kart` (done, n cards heard) and `Jeszcze raz` (again).

### 5.3 Settings

`/ustawienia` gains a **Słuchanie** section:
- `Przerwa na zastanowienie` (seconds, the existing setting);
- `Przerwa przed następną kartą` (seconds, 1–30, default 5);
- `Powtórz odpowiedź` (on/off);
- `Czytaj przykład` (on/off);
- `Czytaj podpowiedź` (on/off, default off);
- `Powtórz przykład` (on/off, default on).

## 6. Verification

Test-first. TTS and ffmpeg are faked in unit tests.

- **Assembly:**
  - The part order for every combination of the five settings.
  - A card with no example.
  - A card with a hint.
  - The key changes with each setting and each spoken text, and stays stable otherwise.
  - A cached hit calls neither TTS nor the encoder.
  - A missing ffmpeg gives 503.
  - Temp files are removed on failure.
- **Selection:**
  - Due cards come first, then never-heard, then least recently heard.
  - The topic filter works, and a switched-off topic is ignored.
  - Ineligible cards are left out.
  - `excludeIds` is honoured.
  - The time budget cuts the list, using both the cached and the estimated duration.
- **Heard:** one row per call; `reviews` and the card's FSRS fields are unchanged.
- **Routes:** session, audio (200 with its headers; 404, 502 and 503), heard, and the settings keys.
- **Screen:**
  - `ended` marks a card heard and advances; skip does not mark it heard.
  - The next file is prefetched.
  - Top-up is requested when fewer than three cards remain.
  - The Media Session handlers are registered and do what §5.2 says.
  - Three failures stop the session.
  - The end summary shows.
- **Real encoder:** a test that runs only when `ffmpeg` is on `PATH` encodes two generated clips plus silences and checks the MP3's duration within ±150 ms.
- **At deploy:**
  - `apt install ffmpeg` on the VM, once.
  - Backup, then the fresh-tree swap.
  - `ffmpeg -version` works.
  - Build one real card on the VM: its MP3 is 64 kbps mono, and its duration matches the sequence.
- **On the phone:** a 10-minute session with the screen locked. The pauses and order hold, the headphone next/pause buttons work, and heard cards rotate out of the next session.

## 7. Out of scope

- iOS.
- Rating cards from headset buttons.
- Speaking the example's Russian translation.
- Offline or background download of a whole session.
- Playback speed.
- Cleaning up outdated `card_audio` entries.
