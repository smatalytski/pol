# Fiszki — generation queue, 429 backoff, and a review window for recordings

Date: 2026-09-18
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-09-12-polish-srs-design.md` and `2026-09-18-card-forms-design.md`.
Supersedes the parts of those that say generation runs inside the capture
pipeline or inside an HTTP request, and the `/dodaj` chip controls.

## 1. What changes, in one paragraph

Every Gemini call moves out of HTTP requests and into a persistent queue,
processed by a worker inside the web server that retries 429s with progressive
backoff. A recording no longer turns straight into a card: once recognised, its
transcript sits on the recording screen for 10 seconds, during which you can
reject it or re-recognise it as Russian. When it leaves the screen it counts as
approved and is queued for generation, and its card appears once generation
succeeds. A word already in the deck is flagged `już masz` on the chip as soon as
it is recognised, and is never queued. The recording screen shows only recent
recordings and their status.

## 2. A recording's life

```
uploaded ──► transcribed ──(approved)──► queued ──► generating ──► generated
   │         (under review)                                            │
   │              │ ──(approved, już masz)──► duplicate                │
   │              │ ──(usuń)──► deleted                         card created
   └──► failed (recognition) ──(ponów)──► uploaded
```

`captures.status` gains `queued`, `generating` and `duplicate`. `failed` now
means only that *recognition* failed. A generation failure never sets it (§6).

## 3. The review window

**A transcribed recording is under review until it is approved.** It is approved
the moment either holds:

- 10 000 ms have passed since its transcript arrived (`transcribed_at`), or
- it is no longer among the **5** most recently transcribed recordings still
  under review (ordered by `transcribed_at` descending, then `created_at`).

The rule is evaluated by the server, from the server's clock. The recording
screen uses the same rule to decide what to show, so "gone from the screen" and
"approved" are one fact, and closing the app mid-window cannot strand a word.
It is one pure function, `isApproved(capture, underReview, now)`, used by both the
list endpoint and the worker.

- **Reject** is `usuń` (or swipe): the recording is deleted. Its audio stays
  stored, as all audio does (original spec §4/§9).
- **`po polsku · po rosyjsku`** re-recognises the stored audio synchronously
  (Speech-to-Text is fast and has its own quota), replaces the transcript, sets
  `transcribed_at` to now — restarting the 10 s — and re-runs the check in §4.

## 4. `już masz`, twice

**At recognition**, right after a transcript is stored, and again after every
re-recognition in the window, the transcript is checked against live `ru_to_pl`
cards. New dictations are always `ru_to_pl`, and dedup is type-scoped (card-forms
spec §2).

- A Latin-script transcript matches a card whose `answer_key` equals
  `answerKey(transcript)`.
- A Cyrillic transcript matches a card whose `answerKey(prompt_text)` equals
  `answerKey(transcript)`.

A match is stored as `captures.duplicate_of`, and the chip shows `już masz`. When
such a recording is approved it becomes `duplicate` and is **not queued**: no
Gemini call is made and no card is created.

**This check is best-effort, deliberately.** It sees only the raw transcript,
while a card is keyed by its generated answer. It misses a transcript that lost a
diacritic (`answerKey` never strips them, on purpose: `l`/`ł` are different
letters). It also misses a card whose Russian prompt has several variants
(`бешеный, взбешённый`).

**At generation**, the existing dedup in `createCard` stays as the backstop.
A duplicate the early check missed still never becomes a second card; it simply
isn't announced, because the chip is gone by then.

## 5. The queue

A new table, `generation_jobs`:

| column | meaning |
|---|---|
| `id` | uuid |
| `kind` | `new` \| `regenerate` \| `rerecognized` |
| `capture_id` | the recording, for `new` and `rerecognized` |
| `card_id` | the card, for `regenerate` and `rerecognized` |
| `status` | `queued` \| `running` \| `done` \| `failed` |
| `attempts` | failed attempts so far |
| `next_attempt_at` | ms; the job is not taken before this |
| `last_error` | the last failure message |
| `created_at`, `finished_at` | ms |

Three kinds, one per path that used to call Gemini synchronously:

- **`new`** — an approved recording. Generates from its transcript and creates a
  card through `createCard` (with its dedup). This is the generation half of
  today's `processCapture`.
- **`regenerate`** — `wygeneruj ponownie` on a `needs_input` card. Generates from
  `answer_pl`, and on a clash keeps the answer (today's `regenerateCard`
  semantics, which the user approved).
- **`rerecognized`** — card-page re-recognition. Speech-to-Text runs
  synchronously in the request; the Gemini half is this job. It rewrites the card
  only if this recording created it, and on a clash leaves it untouched (today's
  `retranscribe` semantics).

**The worker** runs inside the web server, started once from `instrumentation.ts`
`register()`. It starts only when `NEXT_RUNTIME === 'nodejs'` and not during
`next build`, and a flag on `globalThis` guards against a second start. Every
second it runs one tick, and never two at once:

1. **Promote.** Every under-review recording that `isApproved` becomes `queued`
   with a `new` job, or becomes `duplicate` if `duplicate_of` is set.
2. **Respect the pause** (§6). If the queue is paused, the tick stops here.
3. **Run one job.** It takes the oldest `queued` job whose `next_attempt_at` is
   due, marks it `running` (and its recording `generating`), and runs it.

One job at a time, oldest first. Serial processing is itself kind to the quota,
and the volume here — one person dictating — never needs parallelism.

The tick is a thin shell over pure functions that take `now` and injected
providers — `promoteApproved(db, now)` and `runNextJob(deps, now)` — so every
behaviour is testable without a server or a clock.

## 6. Backoff and failures

`GenerationError` gains `retryable: boolean`, set where the error is created.

- **Retryable:** the request itself failed with HTTP 429, 500 or 503, or with a
  network error.
- **Not retryable:** the request succeeded but the response was unusable (no
  content, not JSON, or failing the schema), or the input was empty.

**A retryable failure pauses the whole queue, not just the job.** The quota is
per project, so taking other jobs into the same exhausted quota only buys more
429s. The job returns to `queued`, and both its `next_attempt_at` and the
queue's pause are set to `now + backoff(attempts)`:

```
backoff(n) = d/2 + random() * d/2,   d = min(300 000, 5 000 · 2^(n-1))  ms
```

That is 5 s, 10 s, 20 s, … capped at 5 min, with jitter. `random` is injected.
Retryable failures are retried **indefinitely**, because they are transient by
definition. The pause lives in the worker's memory; a restart clears it, which
costs at most one extra 429.

**A non-retryable failure** gets 3 attempts, with the same backoff but without
pausing the queue, and then gives up:

- A `new` job creates the card from the transcript as `needs_input`, as
  `processCapture`'s fallback does today, so the word is not lost.
- A `regenerate` or `rerecognized` job leaves the card as it was.

Either way the job ends `failed` with `last_error`, and the recording ends
`generated` (it has a card). A `needs_input` card is repaired with
`wygeneruj ponownie`, which queues a `regenerate` job.

**Crash recovery:** at startup, before its first tick, the worker returns every
`running` job to `queued` and its recording to `queued`.

## 7. Screens

### 7.1 `/dodaj` — recent recordings and their status

| state | shows | actions |
|---|---|---|
| not yet uploaded | `wysyłanie…` | — |
| `uploaded` | `rozpoznawanie…` | `usuń` |
| under review, new word | transcript, a bar draining to `review_ends_at` | `po polsku · po rosyjsku`, `usuń` |
| under review, `już masz` | transcript and `już masz` | `po polsku · po rosyjsku`, `usuń` |
| `failed` (recognition) | the error | `ponów`, `usuń` |

- **Removed from the chip:** the audio player, the `tylko formy` switch, the
  tap-to-edit form (there is no card to edit yet), and the old
  `duplicateOf`-from-generation `już masz`.
- **The list endpoint returns only what should be on screen:** uploaded,
  failed-recognition and still-under-review recordings within the existing
  `since` window. An approved one drops out of the response, and so off the
  screen, at the moment it is approved.
- Each under-review item carries `review_ends_at` for the bar. The bar is
  cosmetic; the server decides.
- The screen polls while anything is uploading, recognising or under review,
  then stops, as it does now.
- Swipe-to-delete stays as a shortcut for `usuń`.

### 7.2 `/fiszki` — waiting words on top

- `GET /api/cards` also returns `pending`: recordings that are `queued` or
  `generating`, each with its transcript and state. They are listed above the
  cards with a `w kolejce` or `generowanie…` badge, and they are not tappable,
  since there is no card behind them yet.
- A card with a `regenerate` or `rerecognized` job in flight shows the
  `generowanie…` badge on its own row.
- The list polls while anything is pending, so cards appear as they finish.

### 7.3 `/fiszki/[id]`

- `wygeneruj ponownie` and `po polsku · po rosyjsku` queue a job and return
  immediately, 202.
- `GET /api/cards/:id` returns `generating: boolean`. While it is true, the
  page shows `generowanie…` and disables those controls. It polls, and reloads
  the card when generation finishes; the inputs are already keyed on server
  values, so nothing stale is saved back.
- `tylko formy` stays synchronous, since it makes no Gemini call.

## 8. API

| route | change |
|---|---|
| `POST /api/captures` | unchanged; in the background it now only transcribes and runs the §4 check |
| `GET /api/captures?since=` | returns only on-screen recordings (§7.1), each with `inReview`, `reviewEndsAt`, `duplicateOf` |
| `POST /api/captures/:id/jezyk` | under review: re-recognise synchronously and restart the window. With a card: re-recognise synchronously and queue `rerecognized`. Speech-to-Text failures are returned in `error`, as now |
| `POST /api/captures/:id/retry` | re-runs recognition for a `failed` recording |
| `DELETE /api/captures/:id` | rejects a recording that has no card (under review, uploaded or failed) |
| `POST /api/cards/:id/regeneruj` | queues `regenerate`, returns 202 |
| `GET /api/cards` | adds `pending` and `generatingCardIds` |
| `GET /api/cards/:id` | adds `generating` |

## 9. Data model

**Append-only again:** a new `migrations/002-generation-queue.sql`. The one-time
squash of 2026-09-18 does not repeat, because the deployed database now holds
real cards.

- `captures` gains `transcribed_at INTEGER` and `duplicate_of TEXT REFERENCES
  cards(id)`. Existing rows keep `NULL` for both. They are all `generated`, so
  none is under review.
- The new `generation_jobs` table (§5) has an index on
  `(status, next_attempt_at)`.
- `captures.status` values are a TypeScript enum (there is no CHECK
  constraint), so the new values need no SQL change.

## 10. Verification

Unit tests, test-first as throughout, with injected `now` and `random`:

- **`isApproved`** at its edges: 9 999 ms versus 10 000 ms; the 5th versus the
  6th under review; restarting the window.
- **`promoteApproved`:** a new word gets a `new` job; a `już masz` word becomes
  `duplicate` with no job; a deleted recording gets nothing.
- **`runNextJob`:** a 429 re-queues the job with the exact backoff; the pause
  holds other jobs; the job succeeds on a later tick. Three non-retryable
  failures produce a `needs_input` card. Each of the three kinds applies its own
  clash policy. Crash recovery works.
- **The §4 check:** a Latin match; a Cyrillic match on `prompt_text`; a
  lost-diacritic miss; re-recognition clearing a stale flag.
- **`GenerationError.retryable`** classification.
- **The screens:** a chip drops out when the server stops returning it (tested
  through data, not timers, since the `/dodaj` polling tests are the flakiest in
  the suite); pending rows and the `generowanie…` state.

**At deploy:** a normal fresh-tree swap, with no database drop. Then dictate
several words in a row on the phone and watch each go chip → `w kolejce` →
card. Reject one, and confirm it never appears.

## 11. Out of scope

- Persisting the queue pause across restarts.
- Parallel generation, and job priorities.
- Moving Speech-to-Text or TTS onto the queue. Their quotas are separate and
  have not been exhausted.
- Notifications when a card is ready.
