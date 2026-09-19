# Hands-free Listening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Słuchaj** tab plays a timed listening session that you can follow with the screen off. For each card the phone plays: the Russian prompt, a pause, the Polish answer, optionally the answer again, and optionally the example. Sessions rotate through cards by a separate listening log and never touch the review schedule.

**Architecture:**
- `lib/audio/sequence.ts` (pure) turns a card and the settings into an ordered list of spoken texts and silences, plus a cache key and a duration estimate.
- `lib/audio/card-audio.ts` fetches TTS clips through the existing cache, hands the parts to an injected `Encoder`, and caches the MP3 in `card_audio`.
- `lib/audio/ffmpeg.ts` is the production encoder. It runs one ffmpeg call per card and reads the duration from ffmpeg's `time=` output.
- `lib/listen/service.ts` plans sessions and records `listens`.
- Three thin routes serve those modules.
- `/sluchaj` drives a single `<audio>` element and the Media Session API through a `useListenPlayer` hook.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, SQLite (better-sqlite3) + Drizzle, hand-written SQL migrations, Vitest + jsdom, Google Cloud TTS (Chirp 3 HD), ffmpeg 7.1 (system binary).

**Spec:** `docs/superpowers/specs/2026-09-19-hands-free-audio-design.md`. Read it before any task. Where this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, and `npm run build` exits 0. Read each gate's output before committing. Never chain a commit after a test command with `&&`.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed.
- **Every comment must be true when committed.**
- **Migrations are append-only.** This plan adds exactly one, `migrations/006-listening.sql`. Never edit 001–005. The deployed database holds real cards.
- **Clock is injected:** every stateful function takes `now: Date`.
- **Passive listening:** nothing in this plan writes `reviews` or changes a card's FSRS fields.
- **Exact values:**
  - Sequence:
    - RU `prompt_text` (+ `". " + prompt_hint` when present);
    - `audioGapSeconds` of silence (1–30, default 5);
    - PL `answer_pl`;
    - if `audioRepeatAnswer`: 1000 ms of silence + PL `answer_pl`;
    - if `audioExample` and `example_pl`: 1000 ms of silence + PL `example_pl`;
    - 2000 ms of trailing silence.
  - Encoding: MP3, mono, 24 000 Hz, 64 kbps.
  - Session lengths: `10 | 20 | 30 | 45` minutes. Estimate: 60 ms per spoken character, plus the silences.
  - Top up when fewer than 3 cards remain. Stop after 3 failures in a row.
  - Voices: `ru-RU-Chirp3-HD-Kore` and `pl-PL-Chirp3-HD-Kore` (`VOICES` in `lib/tts`).
  - Media kind: `listen`. `ASSEMBLY_VERSION = 1`.
  - Cache header: `private, max-age=31536000, immutable`.
- **UI strings:** all live in `i18n/pl.ts`, in Polish, with no Cyrillic.
- **ffmpeg 7.1 is installed locally and on the VM**, so the real-encoder test runs everywhere. It still skips itself when `ffmpeg` is not on `PATH`, so CI-like environments without it don't fail.
- `app/dodaj/page.dom.test.tsx` is intermittently flaky. If it alone fails, re-run it and report both runs.

## File map

| File | Responsibility | Task |
|---|---|---|
| `migrations/006-listening.sql`, `lib/db/schema.ts`, `lib/media/store.ts`, `lib/settings.ts`, `app/api/settings/route.ts` | tables, media kind, settings | 1 |
| `lib/audio/sequence.ts` | pure: parts, key, estimate | 2 |
| `lib/audio/ffmpeg.ts` | the production `Encoder` | 3 |
| `lib/audio/card-audio.ts` | build and cache one card's MP3 | 4 |
| `lib/listen/service.ts` | eligibility, session planning, heard | 5 |
| `app/api/listen/**` | three routes | 6 |
| `hooks/useListenPlayer.ts` | playlist, prefetch, top-up, Media Session | 7 |
| `app/sluchaj/page.tsx`, `components/Nav.tsx`, `app/ustawienia/page.tsx`, `i18n/pl.ts` | screens | 8 |

---

### Task 1: Migration 006, media kind, settings

**Files:**
- Create: `migrations/006-listening.sql`
- Modify: `lib/db/schema.ts`, `lib/db/schema-shape.test.ts`, `lib/media/store.ts`, `lib/settings.ts`, `lib/settings.test.ts`, `app/api/settings/route.ts`, `app/api/settings/route.test.ts`

**Interfaces:**
- Produces:
  - Drizzle `cardAudio` (`key`, `mediaId`, `durationMs`, `createdAt`) and `listens` (`id` integer autoincrement, `cardId`, `heardAt`).
  - `media.kind` enum gains `'listen'`, and so does `MediaKind` in `lib/media/store.ts`.
  - `Settings` gains `audioRepeatAnswer: number` and `audioExample: number`, each `0 | 1` and defaulting to `1`. The validators accept only 0 and 1.
  - `PUT /api/settings` accepts `audioRepeatAnswer` and `audioExample` as `0 | 1`.

- [ ] **Step 1: Failing tests.**
  - `lib/db/schema-shape.test.ts`:
    - Extend the migration list with `'006-listening.sql'`.
    - Add a test that `card_audio` has columns `['key','media_id','duration_ms','created_at']`.
    - Add a test that `listens` has columns `['id','card_id','heard_at']`.
    - Add a test that inserting a `listens` row for an unknown card fails with foreign keys ON.
  - `lib/settings.test.ts`:
    - The defaults now include `audioRepeatAnswer: 1, audioExample: 1`.
    - A stored `'0'` is read as 0.
    - A stored `'2'` falls back to the default.
  - `app/api/settings/route.test.ts`:
    - PUT `{ audioRepeatAnswer: 0 }` persists.
    - PUT `{ audioExample: 2 }` is a 400.
- [ ] **Step 2: Run and watch them fail.** `npx vitest run lib/db lib/settings app/api/settings`.
- [ ] **Step 3: Implement.** `migrations/006-listening.sql`:

```sql
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
```

The settings changes:
- `lib/settings.ts`: extend `DEFAULTS` and `VALIDATORS`, with `(n) => n === 0 || n === 1`.
- `app/api/settings/route.ts`: add `audioRepeatAnswer: z.union([z.literal(0), z.literal(1)]).optional()`, and the same for `audioExample`.
- Comments: update `media.kind`'s comment in the Drizzle schema, and `MediaKind`'s comment if it enumerates the kinds.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: migration 006 — card audio cache and listening log; listening settings`.

---

### Task 2: The sequence (pure)

**Files:**
- Create: `lib/audio/sequence.ts`, `lib/audio/sequence.test.ts`

**Interfaces:**
- Produces:

```ts
export const ASSEMBLY_VERSION = 1
export type SequenceSettings = { gapSeconds: number; repeatAnswer: boolean; example: boolean }
export type SpokenPart = { kind: 'speech'; lang: 'pl' | 'ru'; text: string } | { kind: 'silence'; ms: number }
export type ListenCard = { promptText: string; promptHint: string | null; answerPl: string; examplePl: string | null }
export function sequenceFor(card: ListenCard, s: SequenceSettings): SpokenPart[]
export function audioKey(card: ListenCard, s: SequenceSettings): string  // sha256 hex
export function estimateMs(parts: SpokenPart[]): number                   // 60 ms/char + silences
export function settingsToSequence(settings: { audioGapSeconds: number; audioRepeatAnswer: number; audioExample: number }): SequenceSettings
```

- [ ] **Step 1: Failing tests.** In `lib/audio/sequence.test.ts`:
  - **The full sequence:** with the default settings and a card that has a hint and an example, the result equals exactly:

    ```ts
    [
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 2000 },
    ]
    ```

  - **Settings and card variants:**
    - `repeatAnswer: false` drops the second answer and its gap.
    - `example: false` drops the example.
    - A card with a null or blank `examplePl` drops the example even when it is enabled.
    - A null or blank hint gives the prompt alone, not `'кот. '`.
    - `gapSeconds: 12` gives 12000.
  - **`audioKey`:**
    - It is stable for the same input.
    - It changes when any of the four texts changes, or any of the three settings.
    - It includes `ASSEMBLY_VERSION` and both voice names, which you check by building the hash input in the test from the documented fields.
  - **`estimateMs`:** for the sequence above it is `(13 + 3 + 3 + 9) * 60 + 5000 + 1000 + 1000 + 2000`.
  - **`settingsToSequence`:** it maps the 0/1 values to booleans.
- [ ] **Step 2: Run and watch them fail.** The module is missing.
- [ ] **Step 3: Implement.**
  - Trim every text.
  - The key is `sha256(JSON.stringify({ v: ASSEMBLY_VERSION, voices: VOICES, parts: sequenceFor(card, s) }))`.
  - Import `VOICES` from `../tts`. That import is pure data, but `lib/tts` imports the Google SDK. If importing `lib/tts` from `sequence.ts` breaks the page bundle later, move `VOICES` to a tiny `lib/tts/voices.ts` and re-export it from `lib/tts`. Do this now if `tsc` or the build complains.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: a card's listening sequence, cache key and length estimate`.

---

### Task 3: The ffmpeg encoder

**Files:**
- Create: `lib/audio/ffmpeg.ts`, `lib/audio/ffmpeg.test.ts`

**Interfaces:**
- Produces:

```ts
export type EncodePart = { kind: 'clip'; bytes: Uint8Array } | { kind: 'silence'; ms: number }
export interface Encoder { encode(parts: EncodePart[]): Promise<{ bytes: Uint8Array; durationMs: number }> }
export class FfmpegMissingError extends Error {}
export function ffmpegArgs(inputs: { file?: string; silenceMs?: number }[], out: string): string[]
export function parseDurationMs(stderr: string): number | null
export function ffmpegEncoder(opts?: { run?: RunFn; tmpRoot?: string }): Encoder
export function getEncoder(): Encoder
type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>
```

- [ ] **Step 1: Failing tests.**
  - **`ffmpegArgs`:** for `[{file:'/t/0.mp3'},{silenceMs:5000},{file:'/t/2.mp3'}]` and out `/t/out.mp3` it returns exactly this command, which has been verified to produce 24 kHz mono 64 kbps output of the summed length from mixed-rate, mixed-channel inputs:

```ts
['-hide_banner','-y',
 '-i','/t/0.mp3',
 '-f','lavfi','-t','5','-i','anullsrc=r=24000:cl=mono',
 '-i','/t/2.mp3',
 '-filter_complex',
 '[0:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p0];[1:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p1];[2:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p2];[p0][p1][p2]concat=n=3:v=0:a=1[out]',
 '-map','[out]','-ac','1','-ar','24000','-b:a','64k','-f','mp3','/t/out.mp3']
```

    Silence durations are written in seconds with up to 3 decimals, e.g. `'1.5'` for 1500 ms.
  - **`parseDurationMs`:** it returns the **last** `time=HH:MM:SS.xx` in the stderr as milliseconds (e.g. `...time=00:00:01.00...time=00:00:09.00` gives 9000), and null when there is none.
  - **`ffmpegEncoder` with a fake `run`:**
    - clip bytes are written to files in a temp dir under `tmpRoot`, and the args match `ffmpegArgs`;
    - the output file's bytes are returned;
    - the temp dir is gone afterwards on success, **and on failure** (the fake returns `code: 1`, and the encoder throws an Error including the stderr's last line);
    - a `run` that rejects with `code === 'ENOENT'` makes it throw `FfmpegMissingError`.
  - **Real ffmpeg**, with `it.skipIf(!hasFfmpeg)`, where `hasFfmpeg` checks `spawnSync('ffmpeg',['-version']).status === 0`:
    - Generate two short tones with ffmpeg itself into buffers: 1.3 s at 24 kHz mono, and 0.7 s at 44.1 kHz stereo.
    - Encode `[clip, silence 5000, clip, silence 2000]`.
    - Assert `durationMs` is within 150 ms of 9000, and the output starts with an MP3 frame sync or an `ID3` tag.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** with `node:child_process.spawn` inside the default `run`: collect stderr, resolve on `close` with the code, and reject on `error`. Use `fs.mkdtemp(path.join(tmpRoot ?? os.tmpdir(), 'fiszki-listen-'))` and remove it with `fs.rm(dir, { recursive: true, force: true })` in `finally`. Name clip files `${i}.mp3`, where `i` is the part index.
- [ ] **Step 4: Run the tests.** The real-ffmpeg test must run and pass locally, because ffmpeg is installed.
- [ ] **Step 5: Gates, then commit:** `feat: an ffmpeg encoder that joins clips and silences into one MP3`.

---

### Task 4: Building and caching one card

**Files:**
- Create: `lib/audio/card-audio.ts`, `lib/audio/card-audio.test.ts`

**Interfaces:**
- Consumes: `sequenceFor`, `audioKey` (Task 2); `Encoder` (Task 3); `getClip`, `Synthesizer` (`lib/tts`); `getMedia`, `putMedia` (`lib/media/store`); `cardAudio` (Task 1).
- Produces:

```ts
export function cachedAudio(db, card: ListenCard, s: SequenceSettings): { mediaId: string; durationMs: number; key: string } | null
export async function buildCardAudio(deps: { db: Db; synth: Synthesizer; encoder: Encoder }, card: ListenCard, s: SequenceSettings, now: Date): Promise<{ mediaId: string; durationMs: number; key: string }>
```

- [ ] **Step 1: Failing tests** with a fake `Synthesizer` (returns bytes `[lang, ...text]`) and a fake `Encoder` (records its parts; returns `{ bytes: [1,2,3], durationMs: 9000 }`):
  - The encoder receives one `clip` per speech part, in order, carrying exactly the bytes `getClip` stored for that text and language, interleaved with the `silence` parts.
  - A `card_audio` row and a `media` row of kind `listen` are written, and the result carries the key and duration.
  - A second call with the same input calls neither the synthesizer nor the encoder, and returns the cached row.
  - `cachedAudio` returns null before the first build and the row after it.
  - A changed setting builds again under a new key.
  - An encoder that throws `FfmpegMissingError` propagates it, and nothing is cached.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** For each speech part: `mediaId = await getClip(db, synth, text, lang, now)`, then read its bytes with `getMedia`. Encode, `putMedia(db, { kind: 'listen', mime: 'audio/mpeg', bytes, now })`, and insert into `cardAudio` with `onConflictDoNothing`. Read the row back and return it.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: build and cache a card's listening MP3`.

---

### Task 5: Eligibility, session planning, heard

**Files:**
- Create: `lib/listen/service.ts`, `lib/listen/service.test.ts`

**Interfaces:**
- Produces:

```ts
export type PlannedCard = { id: string; promptText: string; topicName: string | null; estimatedMs: number }
export function planSession(db: Db, input: { minutes: number; topicIds?: string[]; excludeIds?: string[] }, now: Date): PlannedCard[]
export function markHeard(db: Db, cardId: string, now: Date): boolean   // false for an unknown card
export function eligibleCard(db: Db, id: string): CardRow | null
export function listenCardOf(card: CardRow): ListenCard
```

- [ ] **Step 1: Failing tests.** Use `createCard`, `topics` inserts (with `isDefault: false`) and direct `listens` inserts.
  - **Eligibility:** these are all excluded:
    - a `pl_to_pl` card;
    - a `needs_input` card;
    - a suspended card;
    - a deleted card;
    - a card in a switched-off topic;
    - a card with a blank `promptText`.
  - **Ordering:** with cards A (due today, heard yesterday), B (due today, never heard), C (not due, never heard), D (not due, heard a week ago) and E (not due, heard yesterday), the order is `B, A, C, D, E`. Due ties break on `due`, then id.
  - **Topic filter:** only the given topics are included, and a switched-off topic among `topicIds` contributes nothing.
  - **`excludeIds`** removes those cards.
  - **Time budget:**
    - with estimates of 20 000 ms each and `minutes: 1`, three cards are returned (the list stops at the first card that reaches or passes 60 000 ms, inclusive);
    - a cached `card_audio` row's `duration_ms` is used instead of the estimate for that card's current key.
  - **`markHeard`:** inserts one `listens` row with `heardAt = now`; the card's `due`, `reps` and `state` are unchanged, and `reviews` is empty; it returns false for an unknown id.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
  - **Eligibility** is `REVIEWABLE` (from `lib/review/queue.ts`) plus `eq(cards.type, 'ru_to_pl')`, with blank prompts filtered in JS (`trim()`).
  - **Last heard** comes from `max(listens.heardAt)` grouped by card, as a `Map`.
  - **End of today** is `startOfLocalDay(now) + 86_400_000`.
  - **Sorting and the budget** happen in JS, which suits a deck of this size.
  - **Per-card duration:** `settingsToSequence(getSettings(db))`, `sequenceFor`, then `cachedAudio(...)?.durationMs ?? estimateMs(parts)`.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: plan a listening session and record what was heard`.

---

### Task 6: Routes

**Files:**
- Create: `app/api/listen/session/route.ts`, `app/api/listen/cards/[id]/audio/route.ts`, `app/api/listen/heard/route.ts`, `app/api/listen/listen.route.test.ts`

**Interfaces:**
- `POST /api/listen/session`:
  - body `{ minutes: 10|20|30|45, topicIds?: string[], excludeIds?: string[] }`;
  - returns 200 `{ cards: PlannedCard[] }`, or 400 for a bad body.
- `GET /api/listen/cards/:id/audio`:
  - returns 200 `audio/mpeg` bytes with `Cache-Control: private, max-age=31536000, immutable` and `ETag: "<key>"`;
  - 404 for an ineligible or unknown card;
  - 503 `{ error: 'ffmpeg missing' }` on `FfmpegMissingError`;
  - 502 `{ error }` on any other build failure.
- `POST /api/listen/heard`:
  - body `{ cardId }`;
  - returns 204, 404 for an unknown card, or 400 for a bad body.

- [ ] **Step 1: Failing tests.**
  - Set up like `app/api/topics/route.test.ts`: a `FISZKI_DB` temp file, keep Ogólne in `beforeEach`.
  - Mock `@/lib/tts` `getSynthesizer` with a fake that returns bytes.
  - Mock `@/lib/audio/ffmpeg` `getEncoder` with a fake. Keep the module's real `FfmpegMissingError` via `importOriginal`.
  - Cover every code above, including the headers.
  - Include one test where the fake encoder throws `FfmpegMissingError` (503) and one where TTS throws (502).
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** thin handlers. The audio route builds with `getSynthesizer()` and `getEncoder()` and responds with `new Response(bytes, { headers })`.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates (the build matters), then commit:** `feat: listening endpoints — session, card audio, heard`.

---

### Task 7: The player hook

**Files:**
- Create: `hooks/useListenPlayer.ts`, `hooks/useListenPlayer.test.ts`

**Interfaces:**

```ts
export type PlayerState =
  | { phase: 'idle' }
  | { phase: 'playing' | 'paused'; index: number; cards: PlannedCard[]; playedMs: number; heard: number }
  | { phase: 'done'; heard: number }
  | { phase: 'failed'; heard: number; error: string }
export function useListenPlayer(opts: { audio: () => HTMLAudioElement; fetchImpl?: typeof fetch; mediaSession?: MediaSession | null }): {
  state: PlayerState
  start(input: { minutes: number; topicIds?: string[] }): Promise<void>
  pause(): void
  resume(): void
  skip(): void
  replay(): void
  stop(): void
}
```

**Behaviour (spec §5.2):**
- **`start`:** posts `/api/listen/session`, loads card 0, and plays.
- **Loading a card:** fetch `/api/listen/cards/:id/audio` into a blob URL, set `audio.src`, then `audio.play()`. The next card's blob is prefetched while the current one plays.
- **On `ended`:**
  - post `/api/listen/heard` for the current card;
  - `heard++`;
  - add `audio.duration * 1000` to `playedMs` (use `card.estimatedMs` if `duration` is not finite);
  - if `playedMs >= minutes * 60000`, the phase is `done`;
  - otherwise advance;
  - when fewer than 3 cards are left after the current one, top up with `excludeIds` (every id so far) and `minutes` (the minutes left, rounded up), appending the returned cards;
  - if nothing is left, the phase is `done`.
- **`skip`:** advances without posting `heard`.
- **`replay`:** sets `audio.currentTime = 0`.
- **`stop`:** pauses, revokes the blob URLs, and sets the phase to `done`.
- **Failures:** a card whose audio fetch fails (not ok, or it throws) is skipped. After 3 consecutive failures the phase is `failed` with the last error; a success resets the counter.
- **Media Session:** when available, set `metadata` for each card (title = `promptText`, artist = `'Fiszki'`, album = `topicName ?? ''`) and register handlers:
  - `play` → `resume`;
  - `pause` → `pause`;
  - `nexttrack` → `skip`;
  - `previoustrack` → `replay`;
  - `stop` → `stop`.
- **Unmount:** clears the handlers and revokes URLs.
- **No `setTimeout` or `setInterval` drives playback.**

- [ ] **Step 1: Failing tests** with `renderHook` (`@testing-library/react`):
  - The fake audio element is an `EventTarget` with `play()` (resolves), `pause()`, `src`, `currentTime`, and a settable `duration`, plus a helper to dispatch `ended`.
  - `fetchImpl` is a fake routing by URL. The session returns N cards, audio returns a `Blob`, and heard returns 204.
  - `URL.createObjectURL` and `revokeObjectURL` are stubbed.
  - `mediaSession` is a fake with a `setActionHandler` spy and `metadata`, plus a global `MediaMetadata` stub.

  Tests:
  - `start` plays card 0, and card 1's audio is fetched before `ended`.
  - `ended` posts heard for card 0 and moves to card 1.
  - `skip` moves on without posting heard.
  - A top-up is requested when fewer than 3 remain, and its body carries `excludeIds`.
  - `playedMs` reaching the budget gives `done` with the right `heard`.
  - 3 failing audio fetches give `failed`; a failure followed by a success does not.
  - The Media Session handlers are registered and call the right actions, and `metadata.title` follows the card.
  - `stop` gives `done` and revokes the URLs.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Hold the session in refs, so the `ended` listener always sees current data, and mirror it into `state` for rendering.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: a listening player — playlist, prefetch, top-up, lock-screen controls`.

---

### Task 8: Screens

**Files:**
- Create: `app/sluchaj/page.tsx`, `app/sluchaj/page.dom.test.tsx`
- Modify: `components/Nav.tsx` (and add a test to `components/Nav.dom.test.tsx`), `app/ustawienia/page.tsx`, `app/ustawienia/page.dom.test.tsx`, `i18n/pl.ts`, `i18n/pl.test.ts`

**Strings to add:** `listen: 'Słuchaj'`, `listenLength: 'czas'`, `listenAllTopics: 'wszystkie'`, `listenStart: 'Start'`, `listenStop: 'Stop'`, `listenPause: 'pauza'`, `listenResume: 'wznów'`, `listenSkip: 'pomiń'`, `listenDone: 'Koniec — przesłuchano'`, `listenCards: 'kart'`, `listenAgain: 'Jeszcze raz'`, `listenFailed: 'nie udało się odtworzyć'`, `listenMinutesLeft: 'zostało min'`, `listenSection: 'Słuchanie'`, `listenGap: 'Przerwa na zastanowienie (s)'`, `listenRepeat: 'Powtórz odpowiedź'`, `listenExample: 'Czytaj przykład'`, `listenSummaryGap: 'przerwa'`, `listenSummaryRepeat: 'odpowiedź ×2'`, `listenSummaryExample: 'przykład'`. `⏸ ▶ ⏭` are symbols with `aria-label`s from the strings.

**Behaviour (spec §5):**
- **Nav:** `Słuchaj` sits between `Powtórki` and `Dodaj`.
- **`/sluchaj`, idle:**
  - length buttons `10 · 20 · 30 · 45 min` (with `aria-pressed`), the last choice kept in `localStorage['fiszki:listen:minutes']` inside try/catch, default 20;
  - topic chips: `wszystkie` plus the switched-on topics from `GET /api/topics`, multi-select, where choosing `wszystkie` clears the others;
  - a summary line from `GET /api/settings`, e.g. `przerwa 5 s · odpowiedź ×2 · przykład`, where each part appears only when enabled, linking to `/ustawienia`;
  - `Start`.
- **Playing or paused:** the current card's Russian prompt (large), its topic name, `n / N`, `zostało min X`, and `⏸`/`▶`, `⏭` and `Stop`.
- **Done:** `Koniec — przesłuchano n kart` and `Jeszcze raz`, which returns to idle with the same choices.
- **Failed:** `nie udało się odtworzyć` plus the error, and `Jeszcze raz`.
- **The audio element:** one `<audio>` element rendered in the page (hidden), passed to `useListenPlayer` via a ref getter.
- **`/ustawienia`:** a `Słuchanie` section with a number input for `audioGapSeconds` (1–30, saved on blur like `newPerDay`) and two checkboxes for `audioRepeatAnswer` and `audioExample`, saved immediately as 0/1. The page's `Settings` type gains the three keys. A failed save shows the existing `settingsSaveFailed`.

- [ ] **Step 1: Failing tests.**
  - **Nav:** order and label.
  - **`/sluchaj`** (mock `useListenPlayer` to control its state and capture calls):
    - `Start` calls `start({ minutes: 20 })` by default, and with the chosen length and topic ids once chosen;
    - the stored length is used on mount;
    - the summary line reflects the settings;
    - each phase renders its texts;
    - the buttons call `pause`, `resume`, `skip` and `stop`.
  - **Settings:** the three controls load, and saving each sends the right PUT body.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Gates, then commit:** `feat: the Słuchaj screen and listening settings`.

---

### Task 9: Deploy and verify (controller-only, with the user's go-ahead)

- [ ] **Step 1:** Gates on the finished branch.
- [ ] **Step 2:** `sudo apt-get install -y ffmpeg` on the VM (a one-time system change, approved as part of deploy), then `ffmpeg -version`.
- [ ] **Step 3:** Back up. Do a fresh-tree swap, detached, building without `/etc/fiszki.env`.
- [ ] **Step 4:** Verify:
  - `_migrations` lists 006, and the card count is unchanged;
  - the pages (including `/sluchaj`) return 200;
  - `POST /api/listen/session {minutes:10}` returns cards;
  - `GET /api/listen/cards/<first>/audio` gives 200 `audio/mpeg`, and `ffprobe` on the body shows mono, 24 kHz, 64 kbps and a plausible duration (the sequence length ± 1 s);
  - a second GET is served from `card_audio` (row count unchanged);
  - `check-providers` passes.
- [ ] **Step 5:** Ask the user to check on the phone: a 10-minute session with the screen locked. The pauses and order hold, the headset next and pause buttons work, and heard cards rotate out of the next session.
