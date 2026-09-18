# Fiszki — cards generated from a topic

Date: 2026-09-18
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-09-12-polish-srs-design.md`, `2026-09-18-card-forms-design.md`
and `2026-09-18-generation-queue-design.md`. Supersedes the queue spec's §11
line "job priorities" (out of scope there): `suggest` jobs run first (§6).

## 1. What changes, in one paragraph

You describe a situation — typed or dictated, in Polish or Russian: "I'm going to
the doctor with my child who has the flu", "I work on a C++ project with git on
Windows", "I'm taking my car to a service" — and the app proposes a round of
vocabulary for it: Polish words and phrases, each with a short Russian gloss.
You strike out what you don't want and accept the rest; the accepted items
become cards in the background, through the existing generation queue. Then you
ask for another round, or finish. Everything generated for a situation belongs
to one **topic**, which can be switched off (and back on) as a whole, and asked
for more at any time.

## 2. Decisions

- **A suggestion shows Polish with a Russian gloss:** `gorączka — температура, жар`.
- **A topic is the label.** It keeps its context; every round and every later
  session lands in it. A card has at most one topic; dictated cards have none.
- **Words versus phrases** is a per-round switch: `mieszane` (≈ 50/50, default),
  `więcej słów` (≈ 80 % words), `więcej fraz` (≈ 80 % phrases). The count per
  round is 5, 10 (default) or 20.
- **No level setting.** Suggestions always skip everyday basics and aim at what a
  fluent non-native speaker is likely to lack in that situation, matching the
  card prompt's assumption about the user.
- **Nothing repeats.** A round never contains a word already in the deck, nor
  anything this topic has ever suggested — accepted or rejected.
- **Leaving a round accepts nothing.** Unlike a dictation's 10 s window, an open
  round waits for you; inaction here should not mean yes.
- **The suggestion call goes through the queue** as a `suggest` job, never inside
  an HTTP request, so it shares the 429 pause and backoff.

## 3. Data model

A new, append-only `migrations/003-topics.sql`. Every change is additive.

### 3.1 `topics`

| column | meaning |
|---|---|
| `id` | uuid |
| `name` | short Polish title, e.g. `U lekarza z dzieckiem`; `NULL` until the first round names it (§5); renamable |
| `context` | what you typed or dictated, verbatim; editable; every round reads it |
| `suspended_at` | ms; set means the whole topic is off |
| `created_at` | ms |

### 3.2 `suggestions`

One row per proposed item, kept forever, so later rounds can exclude it.

| column | meaning |
|---|---|
| `id` | uuid |
| `topic_id` | the topic |
| `round` | 1, 2, 3, … within the topic |
| `answer_pl` | the Polish word or phrase |
| `gloss_ru` | the short Russian gloss |
| `kind` | `slowo` \| `fraza` (ASCII, like `WORD_KINDS`'s `przyslowek`); shown as `słowo` |
| `status` | `proposed` \| `accepted` \| `rejected` |
| `capture_id` | set when accepted (§3.4) |
| `created_at` | ms |

Index on `(topic_id, round)`.

### 3.3 Existing tables

- `cards.topic_id TEXT REFERENCES topics(id)`, nullable.
- `captures.topic_id TEXT REFERENCES topics(id)` and `captures.gloss_ru TEXT`,
  both nullable.
- `generation_jobs.kind` gains `suggest` (a TypeScript enum, so no SQL change);
  the table gains `topic_id TEXT REFERENCES topics(id)` and `params_json TEXT`,
  holding `{"round": n, "count": n, "mix": "mieszane" | "slowa" | "frazy"}`.

### 3.4 An accepted item is an audio-less capture

Accepting a suggestion creates a capture with `audio_media_id = NULL`,
`transcript = answer_pl`, `status = 'queued'`, `topic_id` and `gloss_ru` set, and
enqueues an ordinary `new` job for it. So, with no new machinery:

- it appears on `/fiszki` as `w kolejce` / `generowanie…` through the existing
  `pending` list;
- it never appears on `/dodaj`, which lists only uploading, failed-recognition
  and under-review recordings;
- `createCard`'s dedup remains the backstop.

The card created from such a capture gets the capture's `topic_id`.

### 3.5 Reviews

`REVIEWABLE` (`lib/review/queue.ts`) gains one condition: the card's `topic_id`
is `NULL`, or its topic's `suspended_at` is `NULL`. A card is thus out of review
if it **or** its topic is off. Switching a topic does not touch `cards.suspended_at`,
so turning a topic back on never revives a card you suspended individually.

The new condition is a subquery on a tiny table; confirm with `EXPLAIN QUERY PLAN`
that the review queue still uses `cards_due`.

## 4. Screens

### 4.1 Navigation

A new tab, `tematy`.

### 4.2 `/tematy`

- One row per topic: name, live card count, `+n w kolejce` while any of its
  captures are `queued` or `generating`, and an on/off switch.
- Tapping a row opens `/tematy/[id]`.
- `nowy temat` at the top.

### 4.3 New topic

- A text area and a hold-to-record mic (`useHoldToRecord`, as on `/dodaj`). A
  recording is sent to `POST /api/topics/transcribe`, recognised synchronously
  (as re-recognition already is), and the transcript is put in the text area
  for correction. No capture row is created: the context is not a card.
- Count (5 / 10 / 20), the mix switch, and `zaproponuj`.
- `zaproponuj` creates the topic and its round-1 `suggest` job, and opens the
  topic page.

### 4.4 `/tematy/[id]`

- **Header:** name (tap to rename; `nowy temat…` until named), context (collapsed,
  editable), on/off switch.
- **The current round** is the topic's highest round. Its state is derived:
  - a `suggest` job for the topic is `queued` or `running` → `szukam…`, polling;
  - the latest `suggest` job `failed` → its error and `spróbuj ponownie`, which
    enqueues a new `suggest` job with the same parameters;
  - the round has `proposed` items → the list, below;
  - otherwise (all decided) → only the controls.
- **The list:** `answer_pl — gloss_ru` with a `słowo`/`fraza` marker. Tap or swipe
  to strike an item out; tap again to restore it. Struck-out state is local to
  the page until an accept button is pressed.
- **Controls:** count, mix switch, `przyjmij i jeszcze`, `przyjmij i zakończ`.
  Both accept every item not struck out (§6.3); the first also asks for the next
  round. With no proposed items they read `jeszcze` and are the only action.
- **The topic's cards** below, pending ones first, in the same rows as `/fiszki`.

### 4.5 Elsewhere

- `/fiszki` rows show the topic's name in small grey text.
- `/fiszki/[id]` shows the topic as a link.

## 5. The suggestion prompt

`suggest(input)` in `lib/generate`, beside the card generator: the same Vertex
client, the same `GenerationError` with `retryable` classification.

**Input:** the topic's `context`; the round's `count` and `mix`; an exclusion
list of every `answer_pl` the topic has ever had in `suggestions`.

**Asked for:** `ceil(count × 1.5)` items, to leave room for dedup (below).

**Output schema** (Zod, with `responseSchemaFor` derived as today):

```
{ topic_name: string,
  items: [{ answer_pl: string, gloss_ru: string, kind: 'slowo' | 'fraza' }] }
```

`responseSchemaFor` supports only string fields inside array rows; it is
extended to allow a string enum there too, as its comment asks.

**Rules** (in Russian, like the card prompt):

- The user is a fluent non-native adult. Skip everyday basics; aim at what is
  specific to the situation and likely to be missing.
- Words in dictionary form. Phrases are things one would actually say or hear
  in that situation, not textbook sentences.
- `answer_pl` with correct diacritics. `gloss_ru` short: at most a few
  comma-separated senses. Never English.
- Order by usefulness in the situation.
- Honour the requested word/phrase ratio.
- Nothing from the exclusion list.
- `topic_name`: a short Polish name for the situation.

**After the response, in code:** drop every item whose `answerKey(answer_pl)`
equals that of a live `ru_to_pl` card, of any earlier suggestion in the topic,
or of an earlier item in the same response; keep the first `count` survivors.
A shorter round is acceptable. If the topic has no name, set it from
`topic_name`; otherwise ignore `topic_name`. Insert the survivors as `proposed`
with the job's `round`.

The deck is filtered in code, not sent in the prompt: the deck grows without
bound, the topic's history does not.

### 5.1 Card generation for an accepted item

A `new` job whose capture has a `topic_id` appends two lines to the **user
message** (not the system prompt): the intended Russian meaning (`gloss_ru`) and
the situation (`context`). This keeps the card's `prompt_ru` on the sense you
accepted. Everything else about `new` jobs is unchanged, including the
`needs_input` fallback after three unusable responses.

## 6. Queue and API

### 6.1 The `suggest` job

- **Priority.** In step 3 of a tick, the worker takes the oldest due `suggest`
  job; only if there is none does it take the oldest due job of another kind.
  Promotion and the pause are unchanged.
- **Retryable failure:** as for every job — back to `queued`, and the whole queue
  pauses with backoff. The page keeps showing `szukam…`.
- **Non-retryable failure:** 3 attempts (`failures`), then `failed` with
  `last_error`. No fallback: an empty round saves nothing worth keeping.
- **Crash recovery:** the existing `running → queued` at startup covers it.
- **One round in flight per topic.** A `suggest` job is not enqueued if the topic
  already has one `queued` or `running`.

### 6.2 Endpoints

| route | does |
|---|---|
| `GET /api/topics` | topics with card and pending counts |
| `POST /api/topics` | `{context, count, mix}` → creates the topic and its round-1 `suggest` job |
| `POST /api/topics/transcribe` | audio → transcript, synchronously; stores nothing |
| `GET /api/topics/:id` | the topic, the current round's items and state (§4.4), its cards and pending captures |
| `PATCH /api/topics/:id` | `name`, `context`, `suspendedAt` |
| `POST /api/topics/:id/rounds/:round` | accept a round (§6.3) |
| `POST /api/topics/:id/retry` | re-enqueue the failed `suggest` job's parameters |

### 6.3 Accepting a round

`POST /api/topics/:id/rounds/:round` with `{ rejected: string[], next?: {count, mix} }`,
in one transaction:

1. every `proposed` item of the round becomes `rejected` if listed, otherwise
   `accepted`;
2. each newly accepted item gets its capture and `new` job (§3.4);
3. if `next` is given, a `suggest` job for round `:round + 1` is enqueued,
   subject to §6.1's one-in-flight rule.

Only `proposed` items change, so a repeated request is harmless.

## 7. Verification

Unit tests, test-first, with injected `now` and fakes, in the repo's existing
patterns:

- **Round dedup and trim:** a deck match, a topic-history match (accepted and
  rejected), a duplicate within the response, a short round.
- **Mix → prompt target**, and the `responseSchemaFor` enum-in-row extension.
- **Queue:** a `suggest` job runs before an older `new` job; a retryable failure
  pauses the queue; three unusable responses end `failed`; no second round is
  enqueued while one is in flight; `retry` enqueues the same parameters.
- **Accepting:** statuses, captures and `new` jobs created; a repeated request
  changes nothing; `next` enqueues exactly one round.
- **Reviews:** a card in a suspended topic is not reviewable; resuming the topic
  leaves an individually suspended card suspended.
- **A topic capture's `new` job** sends gloss and context, and its card gets
  `topic_id`.
- **Screens:** striking out and restoring, both accept buttons, `szukam…`, the
  error state with `spróbuj ponownie`, the topic name in `/fiszki` rows.

**Before deploy:** one live run of the suggestion prompt on the three example
situations (doctor with a child with flu; C++, git and Windows; car service),
to judge quality and tune the prompt.

**At deploy:** the usual fresh-tree swap; the database is never dropped. Then
create a topic on the phone, accept a round, and watch the cards arrive.

## 8. Out of scope

- Deleting a topic, moving a card between topics, tagging dictated cards.
- Filtering `/fiszki` by topic.
- A level setting.
- Exact word/phrase counts per round.
