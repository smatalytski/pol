# Fiszki — topic items: three groups, hand-added items, levels, a default topic

Date: 2026-09-19
Status: approved in conversation, awaiting written-spec review
Builds on: `2026-09-18-topic-generation-design.md` and
`2026-09-18-recording-language-design.md`.
Supersedes these parts of the topic-generation spec:
- rounds and "accept the round" (§4.4, §6.3);
- `więcej słów` / `więcej fraz` (§2);
- "dictated cards have no topic" (§2).

## 1. What changes, in one paragraph

A topic becomes a standing list of items in three groups:
- **z kartą**: items that are cards;
- **bez karty**: suggestions and hand-added items waiting for a decision;
- **odrzucone**: discarded items and discarded cards.

A filter switches between the groups. Each item in **bez karty** gets its own `+ karta` and `✕`, and anything in **odrzucone** can be restored. A discarded card keeps its review history and comes back with it. `jeszcze` adds another batch of suggestions to **bez karty**, with `mieszane · tylko słowa · tylko frazy` and a per-batch level, `zaawansowany · średniozaawansowany`. You can add items by hand, typed or dictated in PL or RU, but only after confirming the text. Items and cards can move between topics. Every card belongs to a topic: dictations from `/dodaj` go to a default topic, **Ogólne**, which has no generation.

## 2. Decisions

- **One mechanism for everything in bez karty:** each item has its own `+ karta` / `✕`. Rounds and "accept the round" are gone.
- **Level is chosen per batch,** not per topic, so one topic can hold both advanced and intermediate items.
- **`/dodaj` is unchanged:** a dictation still becomes a card after its 10-second window. It is filed under Ogólne.
- **The groups always follow the card.** Discarding a card, from the topic or with `usuń` on its own page, soft-deletes it and shows it in **odrzucone**. Restoring it undeletes the same card, review history included.
- **Items and cards can move between topics.**
- **Storage (approach B):** live cards are the **z kartą** group. A table, `topic_items`, holds only what is not a live card.
- **Nothing hand-added is saved without confirmation:** a dictated transcript is shown in an editable field first.

## 3. Data model

A new, append-only `migrations/005-topic-items.sql`.

### 3.1 `topic_items` (replaces `suggestions`)

| column | meaning |
|---|---|
| `id`, `topic_id`, `created_at` | as in `suggestions` |
| `answer_pl` | the word or phrase as proposed or confirmed; a hand-added Russian item keeps its Cyrillic text here |
| `gloss_ru` | nullable; empty for hand-added items |
| `kind` | `slowo` \| `fraza`, nullable (hand-added) |
| `source` | `suggested` \| `manual` |
| `level` | `zaawansowany` \| `sredni` for suggested items; null for manual ones |
| `status` | `open` (bez karty) \| `discarded` (odrzucone) \| `carded` (converted) |
| `capture_id` | the capture `+ karta` created; `ON DELETE SET NULL` |
| `card_id` | the card it became, once known |

SQLite cannot drop a NOT NULL constraint, so the migration creates `topic_items`, copies `suggestions` into it and drops `suggestions`. The copy maps `proposed` to `open`, `rejected` to `discarded`, and `accepted` to `carded`, with `card_id` taken from the item's capture where one exists. Copied rows get `source = 'suggested'` and `level = 'zaawansowany'`. `round` is not carried over.

### 3.2 The default topic

- `topics` gains `is_default INTEGER NOT NULL DEFAULT 0`.
- The migration inserts one topic named `Ogólne`, with `is_default = 1` and an empty context.
- Every card with `topic_id IS NULL` gets that topic's id. That includes soft-deleted cards, so they appear in its **odrzucone**.
- From then on, `createCard` without a `topicId` uses the default topic. That covers `/dodaj` dictations and `POST /api/cards`. `cards.topic_id` stays nullable in SQL; code keeps it set.
- The default topic cannot be renamed, has no context and cannot be generated for. It can be switched off like any topic.

### 3.3 The groups

For a topic `X`:
- **z kartą:** live cards with `topic_id = X`, plus the topic's pending captures (`queued` or `generating`), which are shown first.
- **bez karty:** items with `topic_id = X AND status = 'open'`.
- **odrzucone:** items with `status = 'discarded'`, plus soft-deleted cards with `topic_id = X`, newest first.

Items with `status = 'carded'` are in no group. They exist so that a batch never re-suggests them.

## 4. Behaviour

### 4.1 `+ karta` on an item in bez karty

- It creates an audio-less capture and an ordinary `new` job, as accepting did before. The capture has `topic_id`, `gloss_ru` (if any) and `transcript = answer_pl`.
- The item becomes `carded` with `capture_id` set, all in one transaction.
- When the job creates the card, the item's `card_id` is set.
- If `createCard` finds the answer already exists as a live card anywhere, the item links to that card and the card does not move.
- If generation gives up, the word is kept as a `needs_input` card, as today.
- The card prompt receives the gloss (when there is one) and the topic's context. Ogólne has no context, so only the gloss is sent.

### 4.2 Discarding

- **`✕` on an item in bez karty:** its status becomes `discarded`.
- **`✕` on a card in z kartą, or `usuń` on the card page:** the card is soft-deleted (`deleted_at`) and keeps its reviews.

### 4.3 Restoring from odrzucone

- **An item:** its status goes back to `open`.
- **A card:** `deleted_at` is cleared, with FSRS state and reviews untouched. If a live card with the same answer key and type now exists, the restore is refused with 409 `już masz — w temacie …` and nothing changes.

### 4.4 Moving

- `temat: …` sets `topic_id` on a card or an item. The group does not change.
- A card follows its new topic's on/off state immediately.
- Moving to an unknown topic gets a 404.

### 4.5 Generating a batch

- **Params:** `{ count: 5|10|20, mix: 'mieszane'|'slowa'|'frazy', level: 'zaawansowany'|'sredni' }`.
- **Mix:** `slowa` and `frazy` mean 100% of that kind. Items of the other kind are dropped in code, after deduplication. `mieszane` stays about 50/50.
- **Level:** the `suggest` prompt gets one of two instructions.
  - `zaawansowany` is today's rule: the user is fluent, so skip everyday basics and aim at what is specific to the situation.
  - `sredni` treats the user as a solid B1 speaker: include common situational vocabulary a B1 speaker is likely to lack, but still skip absolute basics such as `lekarz` or `dziecko`.
- **New items:** saved as `open`, `source = 'suggested'`, with the batch's `level`.
- **Deduplication is unchanged:** never a live deck word, and never anything the topic has held, in any status. The exclusion list sent to the model covers every `topic_items.answer_pl` of the topic.
- **One batch at a time per topic:** a batch is refused while that topic has a `suggest` job queued or running. With rounds gone, the job's params no longer carry `round`, and the "a rerun never duplicates a round" guard becomes "the job records the ids of the items it inserted, and a rerun that finds them does nothing".
- **Ogólne:** `POST` for a batch on the default topic gets a 400.

### 4.6 Adding by hand

- The screen holds a text field plus **PL**/**RU** hold buttons. A dictation goes to the existing `POST /api/topics/transcribe`, synchronously in the button's language, and its transcript fills the field. Nothing is stored until **dodaj**, and **anuluj** clears the field.
- **dodaj** sends `POST /api/topics/:id/items` with `{ text }`. The server:
  - trims the text and refuses an empty one (400);
  - refuses text whose `answerKey` matches an item the topic already holds, in any status, with 409 `już jest w tym temacie`;
  - refuses text that matches a live card anywhere, with 409 `już masz — w temacie …`; a Cyrillic entry is matched against cards' Russian prompts, like the `już masz` check on `/dodaj`;
  - otherwise saves `source = 'manual'`, `status = 'open'`, and null `gloss_ru`, `kind` and `level`.
- Ogólne accepts hand-added items too.

## 5. Screens

### 5.1 `/tematy`

- Ogólne is pinned first.
- Each row shows `karty · bez karty · odrzucone` counts, `+n w kolejce` while cards are generating, and the on/off switch.

### 5.2 `/tematy/[id]`

- **Header:** name (rename; fixed for Ogólne), context (none for Ogólne), on/off switch.
- **Filter:** tabs `z kartą (n) · bez karty (n) · odrzucone (n)`.
  - The page opens on the last tab used for that topic (browser storage). The first time, it opens on **bez karty** if it has items, otherwise **z kartą**.
- **z kartą:**
  - Pending words come first, then card rows like `/fiszki` (`CardListItem`).
  - Each row has `✕` and `temat: …`.
- **bez karty:**
  - The hand-add bar comes first.
  - Items show `answer — gloss` (the gloss is omitted when empty), a `słowo`/`fraza` marker when known, and a `śr.` badge for intermediate items. Each has `+ karta`, `✕` and `temat: …`.
  - At the bottom are the batch controls: count, `mieszane · tylko słowa · tylko frazy`, `zaawansowany · średniozaawansowany`, and **jeszcze**. They are hidden for Ogólne.
  - `szukam…` shows while a batch runs; a failed batch shows its error and `spróbuj ponownie`.
- **odrzucone:** items and cards, newest first, each with `przywróć`. A card is marked `karta`.
- **The move picker:** `temat: …` opens a list of the other topics.
- **Every action refreshes the view.** A failed action shows `nie udało się zapisać` and leaves the list as it was.

### 5.3 Elsewhere

- **`/tematy/nowy`:** a level switch joins count and mix.
- **`/fiszki/[id]`:**
  - The topic link becomes a `temat: …` picker.
  - `usuń` becomes `przenieś do odrzuconych`, and after it the page goes back to `/fiszki` as before.
- **`/fiszki`:** every row shows its topic name, Ogólne included.
- **`/dodaj`, `/powtorki`:** unchanged.

## 6. API

| route | change |
|---|---|
| `GET /api/topics/:id` | returns `{ topic, groups: { carded, open, discarded }, pending, batch: { state, error } }`; rounds are gone |
| `POST /api/topics/:id/items` | new: add by hand (§4.6) |
| `POST /api/topics/:id/items/:itemId/card` | new: `+ karta` |
| `POST /api/topics/:id/items/:itemId/discard`, `…/restore` | new |
| `PATCH /api/topics/:id/items/:itemId` | new: `{ topicId }` moves an item |
| `POST /api/cards/:id/restore` | new: undelete (409 on conflict) |
| `PATCH /api/cards/:id` | gains `topicId` (move) |
| `POST /api/topics/:id/batches` | replaces `rounds/:round`: `{ count, mix, level }`; 400 for Ogólne |
| `POST /api/topics/:id/retry` | unchanged |
| `POST /api/topics` | gains `level` for the first batch |
| `POST /api/topics/:id/rounds/:round` | removed |

## 7. Verification

Test-first throughout.

- **Migration:** an upgrade from a database at 004 holding a topic-less live card, a topic-less deleted card, and `proposed` / `accepted` (with a capture and a card) / `rejected` suggestions. Afterwards:
  - Ogólne exists exactly once;
  - both cards have its id;
  - the statuses map correctly, and `card_id` is filled.
- **Service tests:**
  - each group query;
  - `+ karta`, including when the card already exists elsewhere;
  - discarding an item and a card;
  - restoring both, including the 409 conflict;
  - moving;
  - adding by hand with both duplicate checks, including Cyrillic;
  - `createCard` defaulting to Ogólne;
  - a batch refused for Ogólne;
  - `slowa`/`frazy` filtering;
  - the level instruction in the prompt.
- **Route tests:** every new and changed endpoint.
- **Screen tests:**
  - the tabs and their counts;
  - the hand-add flow (recognise, edit, **dodaj**; **anuluj**);
  - `+ karta`, `✕` and `przywróć`;
  - the move picker;
  - Ogólne without generation controls;
  - the new level and mix switches.
- **Before deploy:** a live `try-suggestions` run at both levels and all three mixes.
- **At deploy:**
  - backup, then a fresh-tree swap;
  - the card count is unchanged, no card has a null topic, and there is exactly one Ogólne;
  - every old suggestion shows up in exactly one group.
- **On the phone:** a hand-added dictation; a card discarded and restored with its history; a card moved.

## 8. Out of scope

- Creating a topic from the move picker.
- Bulk actions.
- Deleting a topic.
- Merging duplicate cards that live in different topics.
