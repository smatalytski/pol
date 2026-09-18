# Fiszki — word forms on the card, and two card types

Date: 2026-09-18
Status: approved in conversation, awaiting written-spec review
Supersedes: §3 (card model), the forms parts of §5 (generation) and §6
(review), and the `pl_forms` / `image_to_pl` parts of §8 and §9 of
`2026-09-12-polish-srs-design.md`. Everything else there still stands.

## 1. What changes, in one paragraph

Forms stop being a separate card you ask for with `dodaj formy`. Every
generation classifies what was dictated and, for a single word, returns its
forms in two tiers: a short **basic** list always shown on the answer side, and
an **extended** list hidden behind a tap. A second card type, **pl→pl**, lets a
Polish word you already know become a drill of its forms alone. Picture cards
and the old `pl_forms` drill cards are removed. The database is dropped: the
app is in testing and the user has said there is nothing to keep.

## 2. Card types

| type | prompt side | answer side |
|---|---|---|
| `ru_to_pl` | Russian `prompt_text`, plus `prompt_hint` | the Polish word, audio, basic forms, extended toggle, example, grammar note |
| `pl_to_pl` | the Polish word (`answer_pl`) — no Russian anywhere | basic forms, extended toggle, grammar note, audio of the word |

- **Every dictation becomes `ru_to_pl`.** There is no mode toggle; a card is
  switched afterwards (§6).
- **`pl_to_pl` exists only for a word with forms**: `word_kind` is
  `rzeczownik`, `czasownik`, `przymiotnik` or `przyslowek`. It is never offered
  or accepted for `fraza` or `inne`.
- **Switching type costs no model call.** One generation already returns
  everything both types need, and `prompt_text` keeps the Russian regardless of
  type, so switching back restores the ru→pl card exactly.
- **Dedup stays scoped by `(answer_key, type)`.** The same word may exist as a
  ru→pl and a pl→pl card; they are different exercises.
- A **`fraza` card is unchanged** from today: no forms section at all.

## 3. Generation

One call per card, as now. `GeneratedCardSchema` gains three fields:

- `kind` — enum `fraza | rzeczownik | czasownik | przymiotnik | przyslowek | inne`.
  Polish ASCII values, not English, because the system prompt already forbids
  English in the output; the schema enforces the enum either way.
- `forms_basic`, `forms_extended` — arrays of `{ label, value }`. Labels are
  Polish abbreviations; several forms in one value are joined with ` · `.

### 3.1 Classification

The model decides, with rules for the cases a word count gets wrong:

- **`fraza`** — anything that is not a single lexical unit: sentences, idioms
  (`zdrów jak ryba`), multi-word noun phrases (`kleszczowe zapalenie mózgu`).
- **A reflexive verb is one word.** `przyzwyczaić się` is `czasownik`.
- **`inne`** — a single word of any other part of speech: `cześć`, pronouns,
  prepositions, numerals.
- `fraza` and `inne` return both form arrays empty.

### 3.2 Forms by part of speech

| kind | basic | extended |
|---|---|---|
| `rzeczownik` | M. l.mn. · D. l.poj. · D. l.mn. | C., B., Ms., N. — each as `l.poj. · l.mn.` |
| `czasownik` | aspekt + para aspektowa · ja/ty/oni czasu teraźniejszego · tryb rozkazujący 2 os. l.poj. | czas przeszły l.poj. (m/ż/n) · czas przeszły l.mn. (m-os./nie-m-os.) · imiesłowy · forma bezosobowa |
| `przymiotnik` | przysłówek | — |
| `przyslowek` | przymiotnik | — |

Rules the prompt states explicitly:

- **A perfective verb has no present tense.** Its ja/ty/oni row is czas
  przyszły prosty, labelled as such (`zrobię · zrobisz · zrobią`).
- **Only participles that exist for the verb's aspect.** A perfective has no
  `-ący`.
- **A missing number is omitted**, not invented: `nożyczki` (pluralia tantum)
  has no singular rows.
- **A missing derivative is omitted**: an adjective with no adverb returns an
  empty basic list.
- **Wołacz is not included** in the noun extended list, following the request
  as written.

### 3.3 Schema derivation

`responseSchemaFor` currently handles only required strings, and its own
comment says a non-string field must extend it rather than work around it. It
gains exactly two shapes: `z.enum` → `STRING` with `enum`, and
`z.array(z.object({ label: z.string(), value: z.string() }))` → `ARRAY` of
`OBJECT`. Anything else still fails to compile, so the next unsupported shape
is caught the same way.

### 3.4 Model

`gemini-3.8-flash` stays the default. Measured 2026-09-17: both 2.5 models
built a Russian-dictated card backwards (`README.md`, "The model is
load-bearing for Russian dictation"). Latency of the larger response is
measured once it exists, not guessed (§9).

## 4. Data model

One fresh `migrations/001-init.sql`; `002-deleted-at.sql` is folded into it and
deleted. **This breaks the append-only convention exactly once**, and only
because the database is dropped: removing `prompt_media_id` and
`parent_card_id` with an appended migration would need SQLite's table-rebuild
dance, since `DROP COLUMN` refuses a column carrying a foreign key, and that
dance only earns its cost when there is data to preserve. Append-only resumes
from the next change.

`cards` changes:

| column | change |
|---|---|
| `type` | values `ru_to_pl`, `pl_to_pl` |
| `word_kind` | **new**, TEXT, nullable — null only on a card whose generation failed |
| `forms_json` | **new**, TEXT, nullable — `{"basic":[…],"extended":[…]}` |
| `prompt_media_id` | removed |
| `parent_card_id` | removed |

Forms are JSON rather than a table because they are only ever read and written
with their card, never queried on their own.

`media.kind` loses `image`.

## 5. Generation paths that must carry the new fields

Every path that writes generated fields writes `word_kind` and `forms_json`
too: `processCapture`, `retranscribe`, `regenerateCard` (all through
`toCardFields` / `applyGeneratedFields`).

**A pl→pl card that loses its forms reverts to ru→pl.** If regeneration or
re-recognition reclassifies the word as `fraza` or `inne`, a `pl_to_pl` card
would be left with no answer at all, so it becomes `ru_to_pl`.

A card whose generation fails is `needs_input` as today, with `word_kind` and
`forms_json` null; `wygeneruj ponownie` fills them in.

## 6. Switching type

`setCardType(db, id, type, now)` in `lib/cards/service.ts`, behind
`POST /api/cards/:id/typ` with body `{ type }`. A dedicated call rather than a
`type` field on the generic PATCH, because it has rules:

- Refuses `pl_to_pl` unless `word_kind` has forms.
- Refuses when a live card of the target type already owns the key, and reports
  it the same way regeneration reports a clash.
- **Resets the scheduler state**, because the recall task changed: the schedule
  earned by recalling a word from Russian says nothing about recalling its
  forms. Review rows are kept. In practice the switch happens right after
  dictation, before any review, so this only matters for a card switched later
  from the detail page. *Flagged for review: the alternative is to keep the
  schedule.*

## 7. Screens

### 7.1 `/dodaj` chip

Once the card exists:

```
│ wścieklizna                      [▶]
│ karta:     [ru→pl] · tylko formy
│ rozpoznaj: po polsku · po rosyjsku
│                               usuń
```

- **Type switch** — shown only once generation has classified the word as one
  with forms. Needs `type` and `word_kind` on `CaptureView`; `listCaptures`
  already left-joins `cards`, so it selects them there.
- **`usuń`** — a visible button. Swipe-left already deletes, but nothing on
  screen says so; the user asked for a delete that already existed, because it
  was invisible. Swipe stays as a shortcut. Deleting a card and re-dictating the
  word makes a fresh card, since dedup ignores deleted cards.
- Before generation finishes, only `rozpoznaj` and `usuń` are shown.

### 7.2 Review

As in §2. `pokaż wszystkie formy` appears only when the extended list is
non-empty, is hidden by default, and resets for each card. `QueueItem` gains
`wordKind` and `forms`, loses `promptMediaId`.

### 7.3 `/fiszki` list

Title is `answer_pl` for both types. Badges: `do uzupełnienia`, `zawieszona`,
and **`formy`** on a pl→pl card.

### 7.4 `/fiszki/[id]`

Gains the type switch and the same basic/extended forms display, read-only.
`dodaj formy` is removed.

## 8. Audio

`GET /api/cards/:id/audio`:

| part | `ru_to_pl` | `pl_to_pl` |
|---|---|---|
| `answer` | `answer_pl`, Polish voice | `answer_pl`, Polish voice |
| `prompt` | `prompt_text`, Russian voice | `answer_pl`, Polish voice |

Forms are never spoken. The eligibility table's `pl_forms` and `image_to_pl`
branches go, and `hasAnswerAudio` with them — every remaining card has a
speakable answer.

## 9. Removed

- **Picture cards**: `/obrazki` and its nav link, `/api/images`,
  `generator.fromImage`, `lib/media/image.ts`, the `sharp` dependency.
- **`pl_forms`**: `/api/cards/[id]/formy`, `createFormsCard`,
  `generator.forms`, `GeneratedFormsSchema`, `FORMS_SYSTEM`,
  `components/FormsTable.tsx`, `lib/markdown.ts`, the `dodaj formy` control.
- **`lib/cards/display.ts`**: `cardTitle` is `answer_pl` for both types, and
  `hasAnswerAudio` is always true.
- Tests for all of the above go with them.

## 10. Deploy

The production database is dropped and recreated by the migration on first
open. It is **moved aside, not deleted**
(`fiszki.db` → `fiszki.db.pre-forms-2026-09-18`), and the nightly GCS snapshot
also holds a copy, so the drop is reversible until either is removed. Local
`data/fiszki.db` is dropped the same way.

## 11. Verification

**Tests**, written first as throughout: `responseSchemaFor` emits the enum and
the row array, and still rejects other shapes; `toCardFields` maps kind and
forms; `setCardType` enforces both refusals and the reset; the pl→pl revert on
reclassification; `ReviewCard` shows basic forms, hides extended until
toggled, resets per card, and shows no forms for a `fraza`; the chip shows the
type switch only for a word with forms, and a visible `usuń`.

**The Polish is verified against the real model, not unit tests.** A test
asserting "the prompt mentions the genitive" is the can't-fail pattern this
project keeps producing. Instead, one live run on the VM across a fixed word
set, output shown to the user to judge:

| input | checks |
|---|---|
| `kot` | noun, both numbers |
| `nożyczki` | pluralia tantum — no singular rows |
| `robić` | imperfective — present tense |
| `zrobić` | perfective — future simple, labelled; no `-ący` |
| `przyzwyczaić się` | reflexive verb classified `czasownik` |
| `szybki` | adjective → adverb |
| `szybko` | adverb → adjective |
| `zdrów jak ryba` | `fraza`, no forms |
| `kleszczowe zapalenie mózgu` | multi-word noun phrase is `fraza` |
| `cześć` | `inne`, no forms |
| `склеп` | Russian input still builds ru→pl in the right direction, with forms for `grobowiec` |

The same run records per-call latency, since every card's response grows.

## 12. Out of scope

- Editing forms by hand. They are regenerated, not edited.
- Wołacz, comparison of adjectives, and any part of speech beyond the four.
- The intermittently failing `/dodaj` test (`never has the word absent from
  every list`), which predates this change.
