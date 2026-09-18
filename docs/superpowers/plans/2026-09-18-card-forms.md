# Word Forms on the Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every generated card is classified by part of speech and carries its forms (basic always shown, extended behind a tap); a `pl_to_pl` card drills the forms of a known word; picture cards and `pl_forms` drill cards are removed.

**Architecture:** One Gemini call returns `kind`, `forms_basic` and `forms_extended` alongside the existing six fields, enforced by an extended `responseSchemaFor`. They are stored on `cards` as `word_kind` and `forms_json`. Card type becomes `ru_to_pl | pl_to_pl`; switching type is a service call that costs no model call. The review screen, the capture chip and the card detail page render forms through one shared component.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, SQLite via better-sqlite3 + Drizzle (typed queries only, hand-written SQL migrations), Zod 4.6, Vitest + jsdom + React Testing Library, Gemini on Vertex (`@google/genai`).

**Spec:** `docs/superpowers/specs/2026-09-18-card-forms-design.md` — read it before starting any task. Where this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, `npm run build` exits 0. **Vitest does not typecheck** — a missing prop or a stale fixture field passes the suite and fails `tsc`, so `tsc` is not optional. Read each gate's output before committing; never chain a commit after a test command with `&&` and assume.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed. A test that passes before the change proves nothing; say so if one does.
- **Card types:** exactly `ru_to_pl`, `pl_to_pl`.
- **`word_kind` values:** exactly `fraza | rzeczownik | czasownik | przymiotnik | przyslowek | inne` (Polish ASCII, no diacritics).
- **Kinds with forms:** `rzeczownik`, `czasownik`, `przymiotnik`, `przyslowek`. `fraza` and `inne` never carry forms.
- **`forms_json` shape:** `{"basic":[{"label":…,"value":…}],"extended":[…]}`, or `NULL` when both lists are empty.
- **Clock injection:** every stateful function takes `now: Date`; never read the wall clock inside one.
- **All UI strings live in `i18n/pl.ts`**, in Polish.
- **Do not change `FISZKI_MODEL`.** `gemini-2.5-*` builds Russian-dictated cards backwards (README, "The model is load-bearing for Russian dictation").
- **Migrations are squashed exactly once, in Task 3.** No other task edits a migration file.
- A comment that cites a file, function or behaviour must be true when committed. Check it.

## File map

| File | Responsibility | Task |
|---|---|---|
| `lib/cards/forms.ts` (new) | `WordKind`, `CardForms`, `hasForms`, `parseForms`, `serializeForms` — pure, no imports | 3 |
| `migrations/001-init.sql` (replaced) | the whole schema, squashed | 3 |
| `lib/db/schema.ts` | Drizzle mirror of the migration | 3 |
| `lib/generate/index.ts` | schema derivation, generation schema and prompt, `toCardFields` | 1, 2, 4 |
| `lib/cards/service.ts` | card writes, dedup, `applyGeneratedFields`, `setCardType` | 2, 3, 5, 6 |
| `lib/capture/pipeline.ts` | capture → card, `retranscribe`, `listCaptures` | 3, 5, 9 |
| `lib/review/queue.ts` | `QueueItem`, `buildQueue` | 3, 7 |
| `app/api/cards/[id]/typ/route.ts` (new) | `POST` type switch | 6 |
| `app/api/cards/[id]/audio/route.ts` | which text, which voice | 1, 2, 7 |
| `components/FormsView.tsx` (new) | basic rows + extended toggle | 8 |
| `components/CardTypeSwitch.tsx` (new) | `karta: ru→pl · tylko formy` | 9 |
| `components/ReviewCard.tsx` | review screen card | 1, 2, 8 |
| `components/CaptureChip.tsx` | `/dodaj` chip | 9 |
| `app/dodaj/page.tsx` | capture screen | 9 |
| `app/fiszki/page.tsx`, `app/fiszki/[id]/page.tsx` | card list, card detail | 2, 10 |

---

### Task 1: Remove picture cards

**Files:**
- Delete: `app/obrazki/page.tsx`, `app/obrazki/page.dom.test.tsx`, `app/api/images/route.ts`, `app/api/images/route.test.ts`, `lib/media/image.ts`, `lib/media/image.test.ts`
- Modify: `components/Nav.tsx`, `lib/generate/index.ts`, `lib/generate/index.test.ts`, `components/ReviewCard.tsx`, `components/ReviewCard.dom.test.tsx`, `app/api/cards/[id]/audio/route.ts`, `app/api/cards/[id]/audio/route.test.ts`, `app/api/cards/route.ts`, `app/api/cards/route.test.ts`, `lib/capture/pipeline.test.ts`, `lib/media/store.ts` (comment), `i18n/pl.ts`, `README.md:240`, `package.json`

**Interfaces:**
- Produces: `Generator` without `fromImage`. `POST /api/cards` accepts only `type: 'ru_to_pl'`.

The card-type unions in `lib/db/schema.ts`, `lib/cards/service.ts` and `lib/review/queue.ts` still list `image_to_pl` after this task. Task 3 replaces them; leave them.

- [ ] **Step 1: Write the failing test**

Add to `app/api/cards/route.test.ts`, inside its existing `describe` for `POST`:

```ts
  // Picture cards are removed (spec §9): nothing may create one any more.
  it('rejects an image_to_pl card', async () => {
    const res = await POST(
      new Request('http://test/api/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'image_to_pl', promptText: null, promptHint: null, answerPl: 'kot' }),
      }),
    )
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run app/api/cards/route.test.ts`
Expected: FAIL — `expected 200 to be 400`.

- [ ] **Step 3: Remove picture cards**

1. Delete the six files listed above.
2. `components/Nav.tsx`: delete the line `{ href: '/obrazki', label: t.images },`.
3. `lib/generate/index.ts`: delete `fromImage(image: { bytes: Uint8Array; mime: string }): Promise<GeneratedCard>` from `interface Generator`, and the whole `async fromImage({ bytes, mime }) { … },` method from `geminiGenerator`'s returned object.
4. `lib/generate/index.test.ts`: delete the `describe` block whose tests call `.fromImage(`.
5. `components/ReviewCard.tsx`: replace

```tsx
        {card.promptMediaId ? (
          <img src={`/api/media/${card.promptMediaId}`} alt={t.imagePrompt} className="max-h-64 rounded" />
        ) : (
          <p className="text-3xl">{card.promptText}</p>
        )}
```

with

```tsx
        <p className="text-3xl">{card.promptText}</p>
```

6. `components/ReviewCard.dom.test.tsx`: delete the test `'renders an image prompt for a picture card'`, and in `'offers a play control for the answer of ru_to_pl and image_to_pl cards'` delete the `image_to_pl` half and rename it `'offers a play control for the answer of a ru_to_pl card'`.
7. `app/api/cards/[id]/audio/route.ts`: in the `lang` expression replace `card.type === 'ru_to_pl' || card.type === 'image_to_pl'` with `card.type === 'ru_to_pl'`. In its test file delete every test that seeds `type: 'image_to_pl'`.
8. `app/api/cards/route.ts`: change `type: z.enum(['ru_to_pl', 'image_to_pl']),` to `type: z.enum(['ru_to_pl']),`. In its test file delete any other test that posts `image_to_pl` and expects success.
9. `lib/capture/pipeline.test.ts`: in `deps()`, delete the line `fromImage: vi.fn(),`.
10. `lib/media/store.ts`: in the doc comment replace `none of the three current callers (app/api/images/route.ts, lib/tts/index.ts, lib/capture/pipeline.ts)` with `neither current caller (lib/tts/index.ts, lib/capture/pipeline.ts)`, and `Audio, images and TTS clips` with `Audio and TTS clips`. Leave `MediaKind` alone (Task 3).
11. `i18n/pl.ts`: delete `images`, `dropImages` and `imagePrompt`.
12. `README.md:240`: change `One file holds the cards, the review history, the images, the dictation audio` to `One file holds the cards, the review history, the dictation audio`.
13. Run `npm uninstall sharp`.

- [ ] **Step 4: Confirm nothing else still reaches for pictures**

Run: `grep -rnE "fromImage|obrazki|/api/images|media/image|imagePrompt|dropImages|sharp" app lib components hooks i18n scripts package.json`
Expected: no output.

Run: `grep -rn "image_to_pl" app lib components hooks`
Expected: matches only in the type unions of `lib/db/schema.ts`, `lib/cards/service.ts`, `lib/review/queue.ts`, and test fixtures that `tsc` still accepts because of those unions. Task 3 removes them.

- [ ] **Step 5: Run the gates**

Run: `npx tsc --noEmit` → no output. `npx vitest run` → all pass, including the new test. `npm run build` → exit 0, and the route list no longer contains `/obrazki` or `/api/images`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: remove picture cards

No mobile use case (spec §9). Removes /obrazki, /api/images,
generator.fromImage, lib/media/image.ts and the sharp dependency, whose
native binaries had to be fetched or compiled on every VM deploy."
```

---

### Task 2: Remove `pl_forms` cards and `dodaj formy`

**Files:**
- Delete: `app/api/cards/[id]/formy/route.ts`, `app/api/cards/[id]/formy/route.test.ts`, `components/FormsTable.tsx`, `components/FormsTable.dom.test.tsx`, `lib/markdown.ts`, `lib/markdown.test.ts`, `lib/cards/display.ts`, `lib/cards/display.test.ts`
- Modify: `lib/generate/index.ts`, `lib/generate/index.test.ts`, `lib/cards/service.ts`, `lib/cards/service.test.ts`, `components/ReviewCard.tsx`, `components/ReviewCard.dom.test.tsx`, `app/fiszki/page.tsx`, `app/fiszki/page.dom.test.tsx`, `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`, `app/api/cards/[id]/audio/route.ts`, `app/api/cards/[id]/audio/route.test.ts`, `app/api/cards/route.ts`, `lib/capture/pipeline.test.ts`, `i18n/pl.ts`

**Interfaces:**
- Produces: `Generator` = `{ fromDictation(transcript: string): Promise<GeneratedCard> }`. `deleteCard(db, id, now)` soft-deletes exactly one card. No `cardTitle`, no `hasAnswerAudio` — every remaining card's title is `answerPl` and every card's answer is speakable.

- [ ] **Step 1: Write the failing test**

In `app/fiszki/[id]/page.dom.test.tsx`, add:

```tsx
  // Forms are generated with the card now (spec §1); nothing asks for them.
  it('offers no "dodaj formy" control', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    await screen.findByDisplayValue('złośliwy')
    expect(screen.queryByText('dodaj formy')).toBeNull()
  })
```

(The literal string, not `t.addForms` — that key is deleted in this task.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run "app/fiszki/[id]/page.dom.test.tsx" -t "dodaj formy"`
Expected: FAIL — `expected <button …>dodaj formy</button> to be null`.

- [ ] **Step 3: Remove the forms machinery**

1. Delete the eight files listed above.
2. `lib/generate/index.ts`: delete `GeneratedFormsSchema`, `GeneratedForms`, `FORMS_SYSTEM`, `forms(lemma: string): Promise<GeneratedForms>` from `Generator`, and the `async forms(lemma) { … },` method. In `lib/generate/index.test.ts` delete the `describe` block that calls `.forms(`.
3. `lib/cards/service.ts`: delete `createFormsCard` entirely. Replace `deleteCard`'s body and its comment's last paragraph (the one beginning "Cascades to the card's `pl_forms` child") so it reads:

```ts
export function deleteCard(db: Db, id: string, now: Date): void {
  db.update(cards).set({ deletedAt: now.getTime() }).where(eq(cards.id, id)).run()
}
```

Remove `or` from the drizzle import if nothing else uses it. In `lib/cards/service.test.ts` delete the `describe('createFormsCard', …)` block and any test about deleting a parent cascading to its `pl_forms` child.

4. `lib/capture/pipeline.test.ts`: in `deps()`, delete the line `forms: vi.fn(),`.
5. `components/ReviewCard.tsx`: remove the `FormsTable` and `hasAnswerAudio` imports, then replace the revealed block's first two elements with:

```tsx
            <p className="text-3xl font-semibold">{card.answerPl}</p>
            <audio controls preload="none" src={`/api/cards/${card.id}/audio?part=answer`} aria-label={t.play} />
```

Also delete the comment beginning `No Russian on the answer side` and replace it with this true one:

```tsx
            {/* No Russian on the answer side. The Russian prompt above is the
                retrieval cue; once the card is turned over, a Russian gloss of
                the Polish example gives the eye an easier place to land than
                the Polish it is supposed to be reading. */}
```

In `components/ReviewCard.dom.test.tsx` delete `'does not offer a play control for a pl_forms card, whose answer audio 404s'` and `'renders a pl_forms answer through FormsTable instead of as literal Markdown'`.

6. `app/fiszki/page.tsx`: remove the `cardTitle` import and render `{c.answerPl}` where it rendered `{cardTitle(c)}`. In its test delete `'titles a forms card with its Polish prompt, and does not render its table'`.
7. `app/fiszki/[id]/page.tsx`: remove the `FormsTable` and `hasAnswerAudio` imports, the `formsState` state and its comment, the `addForms` function, the `dodaj formy` button and its comment, and the two `formsState` message lines. Replace the answer ternary (`card.type === 'pl_forms' ? <FormsTable…/> : <input…/>`) with just the keyed `<input>` and its comment. Render the `<audio>` unconditionally. In its test delete every test that uses `formsCard`, `t.addForms`, `t.formsAdded` or `t.formsFailed`, and the `FORMS_MARKDOWN` / `formsCard` helpers.
8. `app/api/cards/[id]/audio/route.ts`: replace the `lang` expression and the comment above it with:

```ts
  // Only a ru_to_pl card has a Russian prompt to speak; its answer is always
  // Polish. Deriving the voice from `part` alone would send Polish text to the
  // Russian voice, and because the clip cache is content-addressed, a wrong
  // clip made that way could never be displaced by a later fix.
  const lang: 'pl' | 'ru' | null =
    part === 'prompt' ? (card.type === 'ru_to_pl' ? 'ru' : null) : 'pl'
```

In its test delete every test that seeds `type: 'pl_forms'`.
9. `app/api/cards/route.ts`: delete the comment block above `const Body` (it describes `pl_forms`).
10. `i18n/pl.ts`: delete `addForms`, `formsAdded` and `formsFailed`.

- [ ] **Step 4: Confirm nothing still reaches for `pl_forms`**

Run: `grep -rnE "createFormsCard|FormsTable|lib/markdown|cardTitle|hasAnswerAudio|FORMS_SYSTEM|GeneratedForms|addForms|formsAdded|formsFailed|/formy" app lib components hooks i18n scripts`
Expected: no output.

Run: `grep -rn "pl_forms\|parentCardId" app lib components hooks`
Expected: matches only in the type unions and column definitions of `lib/db/schema.ts`, `lib/cards/service.ts`, `lib/review/queue.ts`, `lib/capture/pipeline.ts`'s `createCard` calls (`parentCardId: null`), and fixtures. Task 3 removes them.

- [ ] **Step 5: Run the gates**

`npx tsc --noEmit` → no output. `npx vitest run` → all pass. `npm run build` → exit 0, no `/api/cards/[id]/formy` in the route list.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: remove pl_forms cards and 'dodaj formy'

Forms are generated with every card from here on (spec §1), so the separate
drill card, its route, the Markdown table renderer and the button that asked
for it all go."
```

---

### Task 3: Squash migrations; add the forms columns

**Files:**
- Create: `lib/cards/forms.ts`, `lib/cards/forms.test.ts`, `lib/db/schema-shape.test.ts`
- Replace: `migrations/001-init.sql`
- Delete: `migrations/002-deleted-at.sql`
- Modify: `lib/db/schema.ts`, `lib/cards/service.ts`, `lib/review/queue.ts`, `lib/capture/pipeline.ts`, `app/api/cards/route.ts`, `lib/media/store.ts`, and every test fixture `tsc` flags

**Interfaces:**
- Produces, from `lib/cards/forms.ts`:
  - `WORD_KINDS: readonly ['fraza','rzeczownik','czasownik','przymiotnik','przyslowek','inne']`
  - `type WordKind`, `type FormRow = { label: string; value: string }`, `type CardForms = { basic: FormRow[]; extended: FormRow[] }`
  - `hasForms(kind: WordKind | null): boolean`
  - `serializeForms(forms: CardForms): string | null`
  - `parseForms(json: string | null): CardForms | null`
- Produces, from `lib/cards/service.ts`: `type CardType = 'ru_to_pl' | 'pl_to_pl'`; `CardRow` gains `wordKind: WordKind | null`, `formsJson: string | null`, loses `promptMediaId`, `parentCardId`.

- [ ] **Step 1: Write the failing tests**

`lib/db/schema-shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTestDb } from './testing'

describe('schema after migrations', () => {
  it('has the card columns the forms design needs, and none of the removed ones', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['type', 'word_kind', 'forms_json', 'deleted_at']))
    expect(cols).not.toContain('prompt_media_id')
    expect(cols).not.toContain('parent_card_id')
  })

  // Squashed once, on 2026-09-18, because the database was dropped (spec §4).
  it('is a single squashed migration', () => {
    const { sqlite } = createTestDb()
    const names = (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(['001-init.sql'])
  })
})
```

`lib/cards/forms.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hasForms, parseForms, serializeForms, type CardForms } from './forms'

const NOUN: CardForms = {
  basic: [{ label: 'M. l.mn.', value: 'koty' }],
  extended: [{ label: 'C.', value: 'kotu · kotom' }],
}

describe('hasForms', () => {
  it('is true for the four kinds that inflect or derive', () => {
    for (const k of ['rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek'] as const) expect(hasForms(k)).toBe(true)
  })

  it('is false for a phrase, another part of speech, and an unclassified card', () => {
    expect(hasForms('fraza')).toBe(false)
    expect(hasForms('inne')).toBe(false)
    expect(hasForms(null)).toBe(false)
  })
})

describe('serializeForms / parseForms', () => {
  it('round-trips', () => {
    expect(parseForms(serializeForms(NOUN))).toEqual(NOUN)
  })

  it('stores nothing when both lists are empty', () => {
    expect(serializeForms({ basic: [], extended: [] })).toBeNull()
  })

  it('reads null as no forms', () => {
    expect(parseForms(null)).toBeNull()
  })

  // forms_json is only ever written by this app, but a review screen must not
  // crash on a corrupt value — it shows no forms instead.
  it('reads corrupt JSON as no forms rather than throwing', () => {
    expect(parseForms('{not json')).toBeNull()
  })

  it('drops rows that are not {label, value} strings', () => {
    expect(parseForms('{"basic":[{"label":"a","value":"b"},{"label":1},"x"],"extended":[]}')).toEqual({
      basic: [{ label: 'a', value: 'b' }],
      extended: [],
    })
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/db/schema-shape.test.ts lib/cards/forms.test.ts`
Expected: `forms.test.ts` fails to import `./forms`; `schema-shape.test.ts` fails with `expected [ …, 'prompt_media_id', … ] not to contain 'prompt_media_id'` and `expected [ '001-init.sql', '002-deleted-at.sql' ] to equal [ '001-init.sql' ]`.

- [ ] **Step 3: Write `lib/cards/forms.ts`**

```ts
/**
 * Word forms carried on a card (spec 2026-09-18 §3–§4). Pure: no database, no
 * React, so the server, the review screen and the tests share one definition.
 */

export const WORD_KINDS = ['fraza', 'rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek', 'inne'] as const
export type WordKind = (typeof WORD_KINDS)[number]

export type FormRow = { label: string; value: string }
export type CardForms = { basic: FormRow[]; extended: FormRow[] }

const WITH_FORMS: ReadonlySet<WordKind> = new Set(['rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek'])

/** Whether a word of this kind has forms at all. `null` is an unclassified card. */
export function hasForms(kind: WordKind | null): boolean {
  return kind !== null && WITH_FORMS.has(kind)
}

/** `null` when there is nothing to store, so "no forms" has one representation. */
export function serializeForms(forms: CardForms): string | null {
  if (forms.basic.length === 0 && forms.extended.length === 0) return null
  return JSON.stringify(forms)
}

function isRow(r: unknown): r is FormRow {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as FormRow).label === 'string' &&
    typeof (r as FormRow).value === 'string'
  )
}

const rows = (x: unknown): FormRow[] => (Array.isArray(x) ? x.filter(isRow) : [])

/**
 * Tolerant on purpose: `forms_json` is only written by this app, but the review
 * screen reads it on every card, and a corrupt value must cost that card its
 * forms rather than crash the session.
 */
export function parseForms(json: string | null): CardForms | null {
  if (!json) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const forms = { basic: rows((v as CardForms).basic), extended: rows((v as CardForms).extended) }
  return forms.basic.length === 0 && forms.extended.length === 0 ? null : forms
}
```

- [ ] **Step 4: Replace the migrations**

Delete `migrations/002-deleted-at.sql`. Replace the whole of `migrations/001-init.sql` with:

```sql
-- Squashed 2026-09-18 (docs/superpowers/specs/2026-09-18-card-forms-design.md
-- §4), replacing the original 001-init.sql and 002-deleted-at.sql. Safe only
-- because the database was dropped at the same moment: removing
-- prompt_media_id and parent_card_id with an appended migration would need
-- SQLite's table rebuild, since DROP COLUMN refuses a column that carries a
-- foreign key. Every later change appends a new migration, as before.

CREATE TABLE media (
  id          TEXT PRIMARY KEY,   -- uuid
  kind        TEXT NOT NULL,      -- 'audio' | 'tts'
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE cards (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,   -- 'ru_to_pl' | 'pl_to_pl'
  prompt_text     TEXT,            -- the Russian prompt; kept on a pl_to_pl card
                                   -- too, so switching back restores it
  prompt_hint     TEXT,
  answer_pl       TEXT NOT NULL,   -- the Polish word, phrase or sentence
  answer_key      TEXT NOT NULL,   -- normalized answer, for duplicate detection
  example_pl      TEXT,
  example_ru      TEXT,
  grammar_note    TEXT,
  word_kind       TEXT,            -- 'fraza' | 'rzeczownik' | 'czasownik' |
                                   -- 'przymiotnik' | 'przyslowek' | 'inne';
                                   -- NULL only when generation failed
  forms_json      TEXT,            -- {"basic":[{label,value}],"extended":[…]};
                                   -- NULL when the word has none
  status          TEXT NOT NULL DEFAULT 'ready',
                                   -- 'ready' | 'needs_input'
                                   -- a card row is created only after generation
                                   -- resolves; in-flight state lives on `captures`
  suspended_at    INTEGER,
  deleted_at      INTEGER,         -- soft delete: the card vanishes from every
                                   -- query while its `reviews` survive
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

Then drop your local development database, which has the old migrations applied and would otherwise keep the old shape: `rm -f data/fiszki.db data/fiszki.db-wal data/fiszki.db-shm`.

- [ ] **Step 5: Update the Drizzle schema and its consumers**

`lib/db/schema.ts`: add `import { WORD_KINDS } from '../cards/forms'`. In `media`, change the kind enum to `['audio', 'tts']`. In `cards`, change `type` to `text('type', { enum: ['ru_to_pl', 'pl_to_pl'] }).notNull()`, delete `promptMediaId` and `parentCardId`, and add after `grammarNote`:

```ts
  wordKind: text('word_kind', { enum: WORD_KINDS }),
  formsJson: text('forms_json'),
```

`lib/cards/service.ts`:
- `export type CardType = 'ru_to_pl' | 'pl_to_pl'`
- delete `promptMediaId` and `parentCardId` from `CreateCardInput` and from the `createCard` insert.
- in `updateCard`, change the promotion to `merged.status === 'needs_input' && merged.promptText ? 'ready' : merged.status`.
- in `findDuplicate`'s comment, replace the paragraph beginning `Dedup is scoped by (answer_key, type)` with:

```ts
  // Dedup is scoped by (answer_key, type): the same word may exist as a
  // ru_to_pl card (recall it from Russian) and a pl_to_pl card (recall its
  // forms), because those are different exercises (spec 2026-09-18 §2).
```

`lib/review/queue.ts`: `import type { CardType } from '../cards/service'`; in `QueueItem` set `type: CardType` and delete `promptMediaId`; delete `promptMediaId: cards.promptMediaId,` from `SELECTION`.

`lib/capture/pipeline.ts`: in both `createCard(…)` calls delete `promptMediaId: null,` and `parentCardId: null,`.

`app/api/cards/route.ts`: in the `createCard` call delete `promptMediaId: null,` and `parentCardId: null,`.

`lib/media/store.ts`: `export type MediaKind = 'audio' | 'tts'`.

- [ ] **Step 6: Fix every fixture `tsc` flags**

Run: `npx tsc --noEmit`
For every error, the fix is mechanical: delete `promptMediaId` and `parentCardId` keys from fixture objects; change any fixture `type: 'pl_forms'` or `'image_to_pl'` to `'ru_to_pl'`; and where a `CardRow` literal is built, add `wordKind: null, formsJson: null`. In `app/powtorki/page.dom.test.tsx` the local `QueueItem` type loses `promptMediaId: null`. Re-run until it prints nothing.

- [ ] **Step 7: Run the gates**

`npx vitest run lib/db/schema-shape.test.ts lib/cards/forms.test.ts` → pass. Then all three gates.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: squash migrations; cards gain word_kind and forms_json

Card type becomes ru_to_pl | pl_to_pl; prompt_media_id and parent_card_id
go. Squashed into one 001 exactly once, because the database is dropped
(spec §4) - removing a foreign-keyed column by appending would need a table
rebuild that only earns its cost when there is data to keep."
```

---

### Task 4: Generation returns `kind` and forms

**Files:**
- Modify: `lib/generate/index.ts`, `lib/generate/index.test.ts`, `scripts/check-providers.ts`, and every `GeneratedCard` fixture `tsc` flags (`lib/capture/pipeline.test.ts`, `lib/cards/service.test.ts`, `app/api/cards/[id]/regeneruj/route.test.ts`, `app/api/captures/[id]/jezyk/route.test.ts`)

**Interfaces:**
- Consumes: `WORD_KINDS`, `hasForms`, `serializeForms` from Task 3.
- Produces: `GeneratedCard` gains `kind: WordKind`, `forms_basic: FormRow[]`, `forms_extended: FormRow[]`. `toCardFields(g)` returns the six existing fields plus `wordKind: WordKind` and `formsJson: string | null`. `responseSchemaFor` accepts string, enum, and array-of-`{string…}`-object fields and throws on anything else.

- [ ] **Step 1: Write the failing tests**

In `lib/generate/index.test.ts`, extend the fixture and add tests. Change `FULL` to:

```ts
const FULL = {
  answer_pl: 'złośliwy',
  prompt_ru: 'злобный, ехидный',
  prompt_hint: 'прилагательное, о человеке',
  example_pl: 'Zrobił to ze złośliwości.',
  example_ru: 'Он сделал это из злобы.',
  grammar_note: '',
  kind: 'przymiotnik' as const,
  forms_basic: [{ label: 'przysłówek', value: 'złośliwie' }],
  forms_extended: [],
}
```

Replace the test `'derives a required-string schema from the Zod schema, so the two cannot drift'` with:

```ts
  it('derives every field from the Zod schema, all required, so the two cannot drift', () => {
    const schema = responseSchemaFor(GeneratedCardSchema) as {
      type: string
      properties: Record<string, { type: string }>
      required: string[]
    }
    const keys = Object.keys(GeneratedCardSchema.shape)
    expect(schema.type).toBe('OBJECT')
    expect(Object.keys(schema.properties)).toEqual(keys)
    expect(schema.required).toEqual(keys)
  })

  // The enum is what makes the model's classification a fact rather than
  // prose: Gemini cannot return "rzeczownik (m.)" against it.
  it('emits kind as a string enum of exactly the six kinds', () => {
    const schema = responseSchemaFor(GeneratedCardSchema) as {
      properties: Record<string, { type: string; enum?: string[] }>
    }
    expect(schema.properties.kind.type).toBe('STRING')
    expect(schema.properties.kind.enum).toEqual([
      'fraza', 'rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek', 'inne',
    ])
  })

  it('emits each forms list as an array of required {label, value} string objects', () => {
    const schema = responseSchemaFor(GeneratedCardSchema) as {
      properties: Record<string, { type: string; items?: { type: string; properties: Record<string, { type: string }>; required: string[] } }>
    }
    for (const key of ['forms_basic', 'forms_extended']) {
      const field = schema.properties[key]
      expect(field.type).toBe('ARRAY')
      expect(field.items?.type).toBe('OBJECT')
      expect(field.items?.properties).toEqual({
        label: expect.objectContaining({ type: 'STRING' }),
        value: expect.objectContaining({ type: 'STRING' }),
      })
      expect(field.items?.required).toEqual(['label', 'value'])
    }
  })

  // The function's contract since it was written: a field shape it does not
  // know must fail loudly, not be silently sent to Gemini as a string.
  it('throws on a field shape it does not support', () => {
    expect(() => responseSchemaFor(z.object({ n: z.number() }) as never)).toThrow(/unsupported/)
  })
```

Add `import { z } from 'zod'` to the test file's imports.

Replace the `toCardFields` test `'maps empty strings to null so the DB holds null, not ""'` expectation with:

```ts
    expect(toCardFields({ ...FULL, example_pl: '', example_ru: '' })).toEqual({
      promptText: 'злобный, ехидный',
      promptHint: 'прилагательное, о человеке',
      answerPl: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      wordKind: 'przymiotnik',
      formsJson: JSON.stringify({ basic: [{ label: 'przysłówek', value: 'złośliwie' }], extended: [] }),
    })
```

and add:

```ts
  // The kind decides, not whatever the model put in the arrays: a phrase
  // never carries forms, so a card cannot claim forms its kind has none of.
  it('stores no forms for a phrase even if the model returned some', () => {
    const f = toCardFields({ ...FULL, kind: 'fraza', forms_basic: [{ label: 'x', value: 'y' }] })
    expect(f.wordKind).toBe('fraza')
    expect(f.formsJson).toBeNull()
  })

  it('stores no forms for a word of a kind with forms when both lists came back empty', () => {
    expect(toCardFields({ ...FULL, kind: 'rzeczownik', forms_basic: [], forms_extended: [] }).formsJson).toBeNull()
  })
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/generate`
Expected: the new schema tests fail (`properties.kind` is undefined); `toCardFields` tests fail on the missing `wordKind` / `formsJson` keys; the unsupported-shape test fails because nothing throws.

- [ ] **Step 3: Extend the schema derivation and the generation schema**

In `lib/generate/index.ts`, add `import { WORD_KINDS, hasForms, serializeForms } from '../cards/forms'`.

Above `GeneratedCardSchema`:

```ts
const FormRowSchema = z.object({
  label: z.string().describe('Short Polish grammatical label, e.g. "D. l.poj." or "tryb rozk."'),
  value: z.string().describe('The Polish form, or several joined with " · "'),
})
```

Append three fields to `GeneratedCardSchema`, after `grammar_note`:

```ts
  kind: z.enum(WORD_KINDS).describe('What was dictated: fraza, or the part of speech of a single word; see the rules'),
  forms_basic: z.array(FormRowSchema).describe('The short list always shown with the answer; [] for fraza and inne'),
  forms_extended: z.array(FormRowSchema).describe('The full list shown on request; [] where the rules give none'),
```

Replace `responseSchemaFor` and its comment with:

```ts
type RowSchema = z.ZodObject<Record<string, z.ZodString>>
export type SupportedField = z.ZodString | z.ZodEnum | z.ZodArray<RowSchema>

function fieldSchema(field: SupportedField): Record<string, unknown> {
  const description = field.description ?? ''
  if (field instanceof z.ZodString) return { type: 'STRING', description }
  if (field instanceof z.ZodEnum) return { type: 'STRING', enum: [...field.options], description }
  if (field instanceof z.ZodArray && field.element instanceof z.ZodObject) {
    return { type: 'ARRAY', description, items: responseSchemaFor(field.element) }
  }
  throw new Error(`responseSchemaFor: unsupported field ${(field as z.ZodType).constructor.name}`)
}

/**
 * Derive Gemini's responseSchema from the Zod schema, so the schema is declared
 * exactly once. Supports exactly three field shapes, because those are all the
 * cards need: a required string, a string enum (the word's kind), and an array
 * of objects whose fields are all strings (a list of form rows). Anything else
 * throws — extend this function rather than work around it, as before.
 */
export function responseSchemaFor(schema: z.ZodObject<Record<string, SupportedField>>) {
  const shape = schema.shape
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, fieldSchema(field)])),
    required: Object.keys(shape),
  }
}
```

In `geminiGenerator`, change the `run` constraint to `async function run<T extends z.ZodObject<Record<string, SupportedField>>>(`.

If `tsc` rejects `GeneratedCardSchema` as an argument to `responseSchemaFor` (Zod's object-shape generic can be stricter than it looks), change only the parameter type to `z.ZodObject` and keep the runtime `throw` — the unsupported-shape test is the guarantee either way. Report which you needed.

Replace `toCardFields` with:

```ts
export function toCardFields(g: GeneratedCard) {
  const orNull = (s: string) => (s.trim() === '' ? null : s)
  return {
    promptText: orNull(g.prompt_ru),
    promptHint: orNull(g.prompt_hint),
    answerPl: g.answer_pl,
    examplePl: orNull(g.example_pl),
    exampleRu: orNull(g.example_ru),
    grammarNote: orNull(g.grammar_note),
    wordKind: g.kind,
    // The kind decides, not whatever came back in the arrays: a phrase or an
    // `inne` word never carries forms, so a card cannot claim forms its kind
    // has none of (spec 2026-09-18 §3.1).
    formsJson: hasForms(g.kind) ? serializeForms({ basic: g.forms_basic, extended: g.forms_extended }) : null,
  }
}
```

- [ ] **Step 4: Add the classification and forms rules to the prompt**

In `SYSTEM`, insert this block immediately before the final line `- Если поле не нужно, верни пустую строку.`:

```
- Поле kind — что продиктовано:
  - fraza — всё, что не является одной лексической единицей: предложения, идиомы («zdrów jak ryba»), многословные именные группы («kleszczowe zapalenie mózgu»);
  - возвратный глагол с «się» — это одно слово: «przyzwyczaić się» это czasownik, а не fraza;
  - inne — одно слово другой части речи: междометия («cześć»), местоимения, предлоги, числительные;
  - иначе — часть речи: rzeczownik, czasownik, przymiotnik, przyslowek.
- forms_basic показывается вместе с ответом всегда, forms_extended — по нажатию. Каждая строка: label — короткая польская помета, value — форма, несколько форм через « · ». Только по-польски. Для fraza и inne оба списка пустые. Если формы не существует, строку пропускай, не выдумывай.
  - rzeczownik: forms_basic — «M. l.mn.», «D. l.poj.», «D. l.mn.»; forms_extended — «C.», «B.», «Ms.», «N.», в каждой «l.poj. · l.mn.». Wołacz не нужен. Если у слова нет одного из чисел (pluralia или singularia tantum), пропусти эти формы.
  - czasownik: forms_basic — «aspekt» (вид и видовая пара, например «ndk. → dk. zrobić»), затем «ja · ty · oni» настоящего времени, затем «tryb rozk.» для ty. У глагола совершенного вида настоящего времени нет: вместо него дай czas przyszły prosty (ja · ty · oni) с пометой «cz. przyszły». forms_extended — «cz. przeszły l.poj.» (m · ż · n), «cz. przeszły l.mn.» (m-os. · nie-m-os.), «imiesłowy» (только те, что существуют для этого вида: у совершенного нет формы на -ący), «forma bezosobowa».
  - przymiotnik: forms_basic — «przysłówek», образованный от него; forms_extended пустой.
  - przyslowek: forms_basic — «przymiotnik», от которого он образован; forms_extended пустой.
```

No unit test asserts this wording — spec §11: the Polish is verified against the real model in Task 11, because a test checking that the prompt "mentions the genitive" cannot fail.

- [ ] **Step 5: Make the post-deploy smoke check see the new fields**

In `scripts/check-providers.ts`, in `checkGemini`, after the `POLISH_LATIN` check add:

```ts
    // "kot" is an unambiguous noun: the kind and at least one basic form must
    // come back, or the forms schema is not reaching the model.
    if (card.kind !== 'rzeczownik') throw new Error(`kind for "kot" was "${card.kind}", not rzeczownik`)
    if (card.forms_basic.length === 0) throw new Error('forms_basic came back empty for "kot"')
```

and change its `detail` to `` `prompt_ru="${card.prompt_ru}" answer_pl="${card.answer_pl}" kind=${card.kind} basic=${JSON.stringify(card.forms_basic)}` ``.

- [ ] **Step 6: Fix the `GeneratedCard` fixtures `tsc` flags**

Run: `npx tsc --noEmit`. Every `GeneratedCard`-shaped fixture needs `kind`, `forms_basic`, `forms_extended`. Use the value that matches the fixture's word: `złośliwy` → `kind: 'przymiotnik', forms_basic: [{ label: 'przysłówek', value: 'złośliwie' }], forms_extended: []`; `zdrów jak ryba` → `kind: 'fraza', forms_basic: [], forms_extended: []`; `krypta` / `grobowiec` → `kind: 'rzeczownik', forms_basic: [{ label: 'M. l.mn.', value: 'krypty' }], forms_extended: []`. Re-run until it prints nothing.

- [ ] **Step 7: Run the gates, then commit**

All three gates. Then:

```bash
git add -A
git commit -m "feat: generation classifies the word and returns its forms

responseSchemaFor gains string enums and arrays of string objects - exactly
the two shapes the forms need - and still throws on anything else. The kind,
not the arrays, decides whether forms are stored. The Polish rules are in the
prompt and verified against the real model at deploy (spec §11), not by
tests that check the prompt's wording."
```

---

### Task 5: Every write path stores kind and forms; pl→pl reverts when forms vanish

**Files:**
- Modify: `lib/cards/service.ts`, `lib/cards/service.test.ts`, `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`

**Interfaces:**
- Consumes: `toCardFields` (Task 4), `hasForms` (Task 3).
- Produces: `GeneratedFields` gains `wordKind: WordKind | null`, `formsJson: string | null`. `CreateCardInput` gains the same two. `UpdateCardPatch` gains `'type' | 'wordKind' | 'formsJson'`. `applyGeneratedFields` may change `type` from `pl_to_pl` to `ru_to_pl`.

- [ ] **Step 1: Write the failing tests**

In `lib/capture/pipeline.test.ts`, inside `describe('processCapture', …)`:

```ts
  it('stores the kind and forms the generation returned', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBe(GENERATED.kind)
    expect(JSON.parse(card.formsJson!)).toEqual({ basic: GENERATED.forms_basic, extended: GENERATED.forms_extended })
  })

  it('stores no kind and no forms when generation fails', async () => {
    const d = deps({ generator: { fromDictation: vi.fn().mockRejectedValue(new Error('429')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBeNull()
    expect(card.formsJson).toBeNull()
  })
```

Inside `describe('retranscribe', …)`:

```ts
  it('replaces the kind and forms when it rebuilds the card', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)
    await retranscribe(d, id, 'ru', NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBe(RU_GENERATED.kind)
    expect(JSON.parse(card.formsJson!).basic).toEqual(RU_GENERATED.forms_basic)
  })
```

In `lib/cards/service.test.ts`, add:

```ts
describe('applyGeneratedFields and the card type', () => {
  const nounFields = {
    promptText: 'кот', promptHint: null, answerPl: 'kot', examplePl: null, exampleRu: null, grammarNote: null,
    wordKind: 'rzeczownik' as const,
    formsJson: JSON.stringify({ basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] }),
  }

  // Spec §5: a pl_to_pl card's whole answer is its forms. If a regeneration
  // reclassifies the word as having none, leaving it pl_to_pl would leave a
  // card with no answer at all.
  it('reverts a pl_to_pl card to ru_to_pl when the new generation has no forms', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ ...nounFields, type: 'pl_to_pl' }), NOW)
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()!
    const { card: after } = applyGeneratedFields(db, card, { ...nounFields, wordKind: 'fraza', formsJson: null }, NOW)
    expect(after.type).toBe('ru_to_pl')
  })

  it('keeps a pl_to_pl card pl_to_pl when forms remain', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ ...nounFields, type: 'pl_to_pl' }), NOW)
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()!
    const { card: after } = applyGeneratedFields(db, card, nounFields, NOW)
    expect(after.type).toBe('pl_to_pl')
    expect(after.formsJson).toBe(nounFields.formsJson)
  })

  it('writes kind and forms onto a ru_to_pl card', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ answerPl: 'kot', wordKind: null, formsJson: null }), NOW)
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get()!
    const { card: after } = applyGeneratedFields(db, card, nounFields, NOW)
    expect(after.wordKind).toBe('rzeczownik')
    expect(after.formsJson).toBe(nounFields.formsJson)
  })
})
```

Add `applyGeneratedFields` to the test file's import from `./service`, and add `wordKind: null, formsJson: null,` to the `input()` helper's defaults.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/capture lib/cards/service.test.ts`
Expected: the new tests fail — `wordKind`/`formsJson` come back `null` because nothing writes them, and the revert test gets `'pl_to_pl'`. (`tsc` would also reject `wordKind` in `CreateCardInput`; the next step adds it.)

- [ ] **Step 3: Carry the fields through `lib/cards/service.ts`**

Add `import { hasForms, type WordKind } from './forms'`.

`CreateCardInput`: add after `grammarNote`:

```ts
  wordKind: WordKind | null
  formsJson: string | null
```

`createCard`'s insert: add `wordKind: input.wordKind, formsJson: input.formsJson,`.

`UpdateCardPatch`: add `'type' | 'wordKind' | 'formsJson'` to the `Pick`.

`updateCard`'s `.set({…})`: add `type: merged.type, wordKind: merged.wordKind, formsJson: merged.formsJson,`.

`GeneratedFields`: add `wordKind: WordKind | null` and `formsJson: string | null`, and change its doc comment to `/** The eight fields a generation produces, as \`toCardFields\` returns them. */`.

Replace `applyGeneratedFields`'s body with:

```ts
  // Spec §5: a pl_to_pl card's whole answer is its forms. If this generation
  // reclassified the word as having none, keeping it pl_to_pl would leave a
  // card with no answer at all, so it reverts. The target type also scopes the
  // clash check below. If reverting collides with a ru_to_pl card for the same
  // word, it still reverts and reports the clash: two ru_to_pl cards for one
  // word are a nuisance, a forms card with no forms is broken.
  const type: CardType = card.type === 'pl_to_pl' && !hasForms(fields.wordKind) ? 'ru_to_pl' : card.type
  const owner = findDuplicate(db, { type, answerPl: fields.answerPl })
  const duplicateOf = owner !== null && owner !== card.id ? owner : null
  const patch: UpdateCardPatch = { ...fields, type, ...(duplicateOf ? { answerPl: card.answerPl } : {}) }
  return { card: updateCard(db, card.id, patch, now), duplicateOf }
```

- [ ] **Step 4: Carry the fields through `lib/capture/pipeline.ts`**

In `strandedFields`, add `wordKind: null, formsJson: null,` to the returned object.

In `processCapture`, replace the inline fallback object

```ts
    : // Generation is down. Keep the word; the prompt is filled in later by hand.
      { promptText: null, promptHint: null, answerPl: transcript, examplePl: null, exampleRu: null, grammarNote: null }
```

with

```ts
    : // Generation is down. Keep the word; `wygeneruj ponownie` fills in the rest.
      strandedFields(transcript)
```

Move `strandedFields` above `processCapture` so it is defined before use.

In both `createCard(…)` calls (in `processCapture` and in `retranscribe`), add `wordKind: fields.wordKind, formsJson: fields.formsJson,` after `grammarNote: fields.grammarNote,`.

- [ ] **Step 5: Run the gates, then commit**

`npx tsc --noEmit` may flag further `CreateCardInput` literals in tests (add `wordKind: null, formsJson: null`). All three gates. Then:

```bash
git add -A
git commit -m "feat: every write path stores word_kind and forms_json

processCapture, retranscribe and regenerateCard all carry them; a failed
generation leaves both null. A pl_to_pl card whose regeneration finds no
forms reverts to ru_to_pl, since its whole answer would otherwise be empty."
```

---

### Task 6: Switching a card's type

**Files:**
- Modify: `lib/cards/service.ts`, `lib/cards/service.test.ts`
- Create: `app/api/cards/[id]/typ/route.ts`, `app/api/cards/[id]/typ/route.test.ts`

**Interfaces:**
- Consumes: `hasForms`, `parseForms` (Task 3); `CardType`, `findDuplicate`, `newState`.
- Produces: `export class CardTypeError extends Error`; `setCardType(db: Db, id: string, type: CardType, now: Date): { card: CardRow; duplicateOf: string | null }`; `POST /api/cards/:id/typ` with body `{ type: 'ru_to_pl' | 'pl_to_pl' }` → `200 { card, duplicateOf }` | `400 { error }`.

- [ ] **Step 1: Write the failing tests**

In `lib/cards/service.test.ts`:

```ts
describe('setCardType', () => {
  const FORMS = JSON.stringify({ basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] })
  const noun = () => input({ answerPl: 'kot', promptText: 'кот', wordKind: 'rzeczownik', formsJson: FORMS })
  const LATER = new Date('2026-09-20T10:00:00')

  it('switches a word with forms to pl_to_pl', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, noun(), NOW)
    const { card, duplicateOf } = setCardType(db, cardId, 'pl_to_pl', LATER)
    expect(card.type).toBe('pl_to_pl')
    expect(duplicateOf).toBeNull()
  })

  // Spec §6: recalling a word from Russian and recalling its forms are
  // different tasks, so the schedule earned by one says nothing about the
  // other. Review rows are not touched.
  it('resets the schedule when the type changes', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, noun(), NOW)
    db.update(cards).set({ reps: 5, state: 2, due: NOW.getTime() + 1e9 }).where(eq(cards.id, cardId)).run()
    const { card } = setCardType(db, cardId, 'pl_to_pl', LATER)
    expect(card.reps).toBe(0)
    expect(card.state).toBe(0)
    expect(card.due).toBe(LATER.getTime())
  })

  it('is a no-op that keeps the schedule when the type is unchanged', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, noun(), NOW)
    db.update(cards).set({ reps: 5 }).where(eq(cards.id, cardId)).run()
    expect(setCardType(db, cardId, 'ru_to_pl', LATER).card.reps).toBe(5)
  })

  it('keeps the Russian prompt, so switching back restores the ru_to_pl card', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, noun(), NOW)
    setCardType(db, cardId, 'pl_to_pl', LATER)
    expect(setCardType(db, cardId, 'ru_to_pl', LATER).card.promptText).toBe('кот')
  })

  it('refuses pl_to_pl for a phrase', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ answerPl: 'zdrów jak ryba', wordKind: 'fraza', formsJson: null }), NOW)
    expect(() => setCardType(db, cardId, 'pl_to_pl', LATER)).toThrow(CardTypeError)
  })

  // A noun whose generation returned no rows would become a forms card with
  // nothing on its answer side.
  it('refuses pl_to_pl for a word of a kind with forms that has none stored', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ answerPl: 'kot', wordKind: 'rzeczownik', formsJson: null }), NOW)
    expect(() => setCardType(db, cardId, 'pl_to_pl', LATER)).toThrow(CardTypeError)
  })

  it('reports the clash and changes nothing when that card already exists', () => {
    const { db } = createTestDb()
    const existing = createCard(db, { ...noun(), type: 'pl_to_pl' }, NOW)
    const { cardId } = createCard(db, noun(), NOW)
    const { card, duplicateOf } = setCardType(db, cardId, 'pl_to_pl', LATER)
    expect(duplicateOf).toBe(existing.cardId)
    expect(card.type).toBe('ru_to_pl')
  })
})
```

Add `CardTypeError, setCardType` to the test file's import from `./service`.

`app/api/cards/[id]/typ/route.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-typ-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { createCard } = await import('@/lib/cards/service')

const NOW = new Date('2026-09-18T10:00:00')

function seed(wordKind: 'rzeczownik' | 'fraza', formsJson: string | null) {
  return createCard(
    db,
    {
      type: 'ru_to_pl', promptText: 'кот', promptHint: null, answerPl: 'kot', examplePl: null,
      exampleRu: null, grammarNote: null, wordKind, formsJson, status: 'ready',
    },
    NOW,
  ).cardId
}

function post(id: string, body: unknown) {
  return POST(
    new Request(`http://test/api/cards/${id}/typ`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  db.delete(cards).run()
})

describe('POST /api/cards/:id/typ', () => {
  it('switches the card and returns it', async () => {
    const id = seed('rzeczownik', JSON.stringify({ basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] }))
    const res = await post(id, { type: 'pl_to_pl' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card.type).toBe('pl_to_pl')
    expect(body.duplicateOf).toBeNull()
  })

  it('rejects a type the app does not have', async () => {
    const id = seed('rzeczownik', null)
    expect((await post(id, { type: 'image_to_pl' })).status).toBe(400)
  })

  it('answers 400 with a message when the word has no forms', async () => {
    const id = seed('fraza', null)
    const res = await post(id, { type: 'pl_to_pl' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/forms/)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/cards/service.test.ts "app/api/cards/[id]/typ"`
Expected: service tests fail importing `setCardType` / `CardTypeError`; the route test cannot resolve `./route`. Create the route file as a stub first so the route tests fail on behaviour:

```ts
import { NextResponse } from 'next/server'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await params
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}
```

Re-run: route tests now fail with `expected 501 to be 200` / `…to be 400`.

- [ ] **Step 3: Implement `setCardType`**

In `lib/cards/service.ts`, extend the forms import to `import { hasForms, parseForms, type WordKind } from './forms'`, then add:

```ts
/** A type switch the card cannot take — answered as a 400, not a crash. */
export class CardTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardTypeError'
  }
}

/**
 * Switches a card between ru_to_pl and pl_to_pl (spec 2026-09-18 §6). Costs no
 * model call: one generation already stored everything both types need, and
 * `prompt_text` keeps the Russian either way, so switching back restores the
 * ru_to_pl card exactly.
 *
 * Resets the schedule, because the recall task changed — the schedule earned
 * by recalling a word from Russian says nothing about recalling its forms.
 * Review rows are kept. In practice the switch happens right after dictation,
 * before any review.
 */
export function setCardType(
  db: Db,
  id: string,
  type: CardType,
  now: Date,
): { card: CardRow; duplicateOf: string | null } {
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), isNull(cards.deletedAt)))
    .get()
  if (!card) throw new Error(`no such card: ${id}`)
  if (card.type === type) return { card, duplicateOf: null }

  // A pl_to_pl card's whole answer is its forms. Checked on the stored forms
  // too, not only the kind: a noun whose generation returned no rows would
  // become a forms card with nothing on its answer side.
  if (type === 'pl_to_pl' && (!hasForms(card.wordKind) || parseForms(card.formsJson) === null)) {
    throw new CardTypeError(`this word has no forms to drill: ${id}`)
  }

  const owner = findDuplicate(db, { type, answerPl: card.answerPl })
  if (owner !== null && owner !== id) return { card, duplicateOf: owner }

  db.update(cards)
    .set({ type, ...newState(now), updatedAt: now.getTime() })
    .where(eq(cards.id, id))
    .run()
  return { card: db.select().from(cards).where(eq(cards.id, id)).get()!, duplicateOf: null }
}
```

- [ ] **Step 4: Implement the route**

Replace `app/api/cards/[id]/typ/route.ts` with:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { CardTypeError, setCardType } from '@/lib/cards/service'

const Body = z.object({ type: z.enum(['ru_to_pl', 'pl_to_pl']) })

/**
 * Switch a card between recalling it from Russian and drilling its forms. A
 * dedicated route rather than a `type` field on the generic PATCH, because the
 * switch has rules — see setCardType. A CardTypeError is the one refusal
 * expected in normal use and comes back as a 400 with a message; an unknown
 * card propagates like every other route's "no such card" here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'type must be ru_to_pl or pl_to_pl' }, { status: 400 })
  try {
    return NextResponse.json(setCardType(db, id, body.data.type, new Date()))
  } catch (err) {
    if (err instanceof CardTypeError) return NextResponse.json({ error: err.message }, { status: 400 })
    throw err
  }
}
```

- [ ] **Step 5: Run the gates, then commit**

All three gates; `npm run build` lists `/api/cards/[id]/typ`. Then:

```bash
git add -A
git commit -m "feat: switch a card between ru_to_pl and pl_to_pl

No model call - one generation already stored everything both types need.
Refuses pl_to_pl for a word with no stored forms, reports a clash with an
existing card instead of forking, and resets the schedule because the recall
task changed (spec §6)."
```

---

### Task 7: Review data — queue items carry forms; audio for pl→pl

**Files:**
- Modify: `lib/review/queue.ts`, `lib/review/queue.test.ts`, `app/api/cards/[id]/audio/route.ts`, `app/api/cards/[id]/audio/route.test.ts`, and fixtures `tsc` flags (`components/ReviewCard.dom.test.tsx`, `hooks/useReviewSession.test.ts`, `app/powtorki/page.dom.test.tsx`, `app/api/review/queue/route.test.ts`)

**Interfaces:**
- Consumes: `parseForms`, `CardForms`, `WordKind` (Task 3).
- Produces: `QueueItem = { id; type: CardType; promptText: string | null; promptHint: string | null; answerPl: string; examplePl: string | null; grammarNote: string | null; wordKind: WordKind | null; forms: CardForms | null; isNew: boolean }` — `exampleRu` is dropped, nothing on the review screen shows it.

- [ ] **Step 1: Write the failing tests**

In `lib/review/queue.test.ts`, its `insertCard(db, over)` helper seeds a fresh reviewable `ru_to_pl` card (Task 3 already removed `promptMediaId` and `parentCardId` from it). Add a new `describe`:

```ts
describe('buildQueue forms', () => {
  it('hands each card its forms parsed, ready to render', async () => {
    const { db } = createTestDb()
    const forms = { basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] }
    insertCard(db, { answerPl: 'kot', answerKey: 'kot', wordKind: 'rzeczownik', formsJson: JSON.stringify(forms) })
    const [item] = await buildQueue(db, NOW)
    expect(item.wordKind).toBe('rzeczownik')
    expect(item.forms).toEqual(forms)
  })

  it('gives a card with no stored forms null forms', async () => {
    const { db } = createTestDb()
    insertCard(db, { wordKind: 'fraza', formsJson: null })
    const [item] = await buildQueue(db, NOW)
    expect(item.forms).toBeNull()
  })
})
```

In `app/api/cards/[id]/audio/route.test.ts`:

```ts
  // Spec §8: a pl_to_pl card's prompt IS the Polish word, so "the prompt" is
  // spoken in Polish from answer_pl — never the stored Russian prompt_text.
  it('speaks a pl_to_pl prompt as the Polish word', async () => {
    seedCard({ id: 'f1', type: 'pl_to_pl', promptText: 'кот', answerPl: 'kot' })
    const res = await call('f1', 'prompt')
    expect(res.status).toBe(307)
    expect(getClipMock.mock.calls[0]?.[2]).toBe('kot')
    expect(getClipMock.mock.calls[0]?.[3]).toBe('pl')
  })

  it('speaks a pl_to_pl answer as the Polish word', async () => {
    seedCard({ id: 'f2', type: 'pl_to_pl', answerPl: 'kot' })
    await call('f2', 'answer')
    expect(getClipMock.mock.calls[0]?.[2]).toBe('kot')
    expect(getClipMock.mock.calls[0]?.[3]).toBe('pl')
  })
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/review/queue.test.ts "app/api/cards/[id]/audio"`
Expected: `item.forms` is `undefined`; the pl_to_pl prompt test gets a 404 (`nothing to speak`).

- [ ] **Step 3: Implement**

`lib/review/queue.ts`: add `import { parseForms, type CardForms, type WordKind } from '../cards/forms'`. Replace `QueueItem` with the shape in **Interfaces** above. In `SELECTION`, delete `exampleRu: cards.exampleRu,` and add `wordKind: cards.wordKind, formsJson: cards.formsJson,`. Replace the final `return interleave(…)` with:

```ts
  // forms_json is parsed here, once, so the review screen receives rows rather
  // than a string it would have to know how to decode.
  const toItem = ({ formsJson, ...c }: (typeof due)[number], isNew: boolean): QueueItem => ({
    ...c,
    forms: parseForms(formsJson),
    isNew,
  })

  return interleave(
    due.map((c) => toItem(c, false)),
    fresh.map((c) => toItem(c, true)),
  )
```

`app/api/cards/[id]/audio/route.ts`: replace the `lang` block and the `text` line with:

```ts
  // Only a ru_to_pl card has a Russian prompt. A pl_to_pl card's prompt IS the
  // Polish word, so its prompt is spoken from answer_pl in the Polish voice
  // (spec 2026-09-18 §8). Forms are never spoken. Deriving the voice from
  // `part` alone would send Polish text to the Russian voice, and because the
  // clip cache is content-addressed, a wrong clip made that way could never be
  // displaced by a later fix.
  const russianPrompt = part === 'prompt' && card.type === 'ru_to_pl'
  const lang: 'pl' | 'ru' = russianPrompt ? 'ru' : 'pl'
  const text = russianPrompt ? card.promptText : card.answerPl
```

Keep the existing `if (!text) return … 404` line after it.

- [ ] **Step 4: Fix the `QueueItem` fixtures `tsc` flags**

Run `npx tsc --noEmit`. For each `QueueItem` literal: delete `exampleRu`, add `wordKind: null, forms: null`. Re-run until clean.

- [ ] **Step 5: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: review queue carries parsed forms; pl_to_pl audio is Polish

QueueItem gains wordKind and forms and drops exampleRu, which nothing on the
review screen shows. A pl_to_pl prompt is the Polish word, so it is spoken
from answer_pl in the Polish voice."
```

---

### Task 8: Forms on the review screen

**Files:**
- Create: `components/FormsView.tsx`, `components/FormsView.dom.test.tsx`
- Modify: `components/ReviewCard.tsx`, `components/ReviewCard.dom.test.tsx`, `i18n/pl.ts`

**Interfaces:**
- Consumes: `CardForms`, `FormRow` (Task 3); `QueueItem` (Task 7).
- Produces: `<FormsView forms={CardForms | null} />` — renders nothing for `null`; basic rows always; a `pokaż wszystkie formy` / `ukryj formy` toggle and the extended rows only when `extended` is non-empty. Re-mount it (via `key`) to reset the toggle.

- [ ] **Step 1: Add the strings**

`i18n/pl.ts`, after `regenerateDuplicate`:

```ts
  showAllForms: 'pokaż wszystkie formy',
  hideAllForms: 'ukryj formy',
```

- [ ] **Step 2: Write the failing tests**

`components/FormsView.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FormsView } from './FormsView'
import { t } from '@/i18n/pl'

afterEach(cleanup)

const NOUN = {
  basic: [{ label: 'M. l.mn.', value: 'koty' }, { label: 'D. l.poj.', value: 'kota' }],
  extended: [{ label: 'C.', value: 'kotu · kotom' }],
}

describe('FormsView', () => {
  it('shows the basic forms', () => {
    render(<FormsView forms={NOUN} />)
    expect(screen.getByText('M. l.mn.')).toBeTruthy()
    expect(screen.getByText('koty')).toBeTruthy()
    expect(screen.getByText('kota')).toBeTruthy()
  })

  it('hides the extended forms until asked, then hides them again', () => {
    render(<FormsView forms={NOUN} />)
    expect(screen.queryByText('kotu · kotom')).toBeNull()
    fireEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('kotu · kotom')).toBeTruthy()
    fireEvent.click(screen.getByText(t.hideAllForms))
    expect(screen.queryByText('kotu · kotom')).toBeNull()
  })

  it('offers no toggle when there are no extended forms', () => {
    render(<FormsView forms={{ basic: NOUN.basic, extended: [] }} />)
    expect(screen.queryByText(t.showAllForms)).toBeNull()
  })

  it('renders nothing without forms', () => {
    const { container } = render(<FormsView forms={null} />)
    expect(container.innerHTML).toBe('')
  })
})
```

In `components/ReviewCard.dom.test.tsx`, give the shared `card` fixture `forms: { basic: [{ label: 'przysłówek', value: 'złośliwie' }], extended: [{ label: 'x', value: 'rozszerzone' }] }` and `wordKind: 'przymiotnik'`, then add:

```tsx
  it('shows the basic forms with the answer, and the extended ones only on request', async () => {
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByText('złośliwie')).toBeTruthy()
    expect(screen.queryByText('rozszerzone')).toBeNull()
    await userEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('rozszerzone')).toBeTruthy()
  })

  it('does not show forms before the answer is revealed', () => {
    render(<ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.queryByText('złośliwie')).toBeNull()
  })

  // Spec §7.2: the toggle is per card. Without a reset, opening it once would
  // leave every following card's extended forms open.
  it('closes the extended forms again for the next card', async () => {
    const { rerender } = render(
      <ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    await userEvent.click(screen.getByText(t.showAllForms))
    rerender(
      <ReviewCard card={{ ...card, id: 'b' }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByText('rozszerzone')).toBeNull()
  })

  it('shows no forms section for a phrase', () => {
    render(
      <ReviewCard card={{ ...card, wordKind: 'fraza', forms: null }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByText(t.showAllForms)).toBeNull()
  })

  // Spec §2: pl_to_pl is the Polish word as the question and its forms as the
  // answer. No Russian anywhere — not the prompt, not the hint.
  it('asks a pl_to_pl card with the Polish word and no Russian', () => {
    render(
      <ReviewCard card={{ ...card, type: 'pl_to_pl' }} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.getByText('złośliwy')).toBeTruthy()
    expect(screen.queryByText('злобный')).toBeNull()
    expect(screen.queryByText('прилагательное')).toBeNull()
  })

  it('answers a pl_to_pl card with its forms, not a second copy of the word or an example', () => {
    render(
      <ReviewCard card={{ ...card, type: 'pl_to_pl' }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.getAllByText('złośliwy')).toHaveLength(1)
    expect(screen.getByText('złośliwie')).toBeTruthy()
    expect(screen.queryByText('Zrobił to ze złośliwości.')).toBeNull()
  })
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run components/FormsView.dom.test.tsx components/ReviewCard.dom.test.tsx`
Expected: `FormsView` cannot be imported; the ReviewCard forms tests find no `złośliwie`; the pl_to_pl prompt test finds `злобный`.

- [ ] **Step 4: Write `components/FormsView.tsx`**

```tsx
'use client'
import { useState } from 'react'
import type { CardForms, FormRow } from '@/lib/cards/forms'
import { t } from '@/i18n/pl'

function Rows({ rows }: { rows: FormRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-sm">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="contents">
          <dt className="text-neutral-500">{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A word's forms (spec 2026-09-18 §7): the basic list always, the extended
 * list behind a tap. The toggle is local state, so a parent that wants it
 * closed again for the next card re-mounts this with a `key`.
 */
export function FormsView({ forms }: { forms: CardForms | null }) {
  const [showAll, setShowAll] = useState(false)
  if (!forms) return null
  return (
    <div className="flex flex-col items-center gap-2">
      {forms.basic.length > 0 && <Rows rows={forms.basic} />}
      {forms.extended.length > 0 && (
        <>
          <button onClick={() => setShowAll((s) => !s)} className="text-sm underline">
            {showAll ? t.hideAllForms : t.showAllForms}
          </button>
          {showAll && <Rows rows={forms.extended} />}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Render forms in `components/ReviewCard.tsx`**

Add `import { FormsView } from './FormsView'`. Replace the prompt-side block and the revealed block with:

```tsx
        {/* A pl_to_pl card asks with the Polish word itself, and carries no
            Russian anywhere (spec 2026-09-18 §2). */}
        <p className="text-3xl">{isForms ? card.answerPl : card.promptText}</p>
        {!isForms && card.promptHint && <p className="text-sm text-neutral-500">{card.promptHint}</p>}

        {revealed && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {!isForms && <p className="text-3xl font-semibold">{card.answerPl}</p>}
            <audio controls preload="none" src={`/api/cards/${card.id}/audio?part=answer`} aria-label={t.play} />
            {/* Keyed on the card, so the extended toggle closes again for the
                next card instead of staying open for every one after it. */}
            <FormsView key={card.id} forms={card.forms} />
            {!isForms && card.examplePl && <p className="text-lg">{card.examplePl}</p>}
            {/* No Russian on the answer side. The Russian prompt above is the
                retrieval cue; once the card is turned over, a Russian gloss of
                the Polish example gives the eye an easier place to land than
                the Polish it is supposed to be reading. */}
            {card.grammarNote && <p className="text-sm text-neutral-500">{card.grammarNote}</p>}
          </div>
        )}
```

with, at the top of the component body, `const isForms = card.type === 'pl_to_pl'`.

- [ ] **Step 6: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: basic forms with every answer, extended forms on request

FormsView shows the basic list always and the extended list behind a toggle
that closes again for each new card. A pl_to_pl card asks with the Polish
word and answers with its forms, with no Russian anywhere."
```

---

### Task 9: `/dodaj` chip — type switch and a visible delete

**Files:**
- Create: `components/CardTypeSwitch.tsx`, `components/CardTypeSwitch.dom.test.tsx`
- Modify: `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `components/CaptureChip.tsx`, `components/CaptureChip.dom.test.tsx`, `app/dodaj/page.tsx`, `app/dodaj/page.dom.test.tsx`, `i18n/pl.ts`

**Interfaces:**
- Consumes: `CardType` (Task 3), `hasForms` (Task 3), `POST /api/cards/:id/typ` (Task 6).
- Produces: `CaptureView` gains `cardType: CardType | null`, `wordKind: WordKind | null`. `<CardTypeSwitch type={CardType} onChange={(type: CardType) => void} />`. `CaptureChip` gains prop `onSetType: (cardId: string, type: CardType) => void`.

- [ ] **Step 1: Add the strings**

`i18n/pl.ts`, after `hideAllForms`:

```ts
  typeLabel: 'karta',
  typeRuPl: 'ru→pl',
  typePlPl: 'tylko formy',
```

- [ ] **Step 2: Write the failing tests**

`components/CardTypeSwitch.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardTypeSwitch } from './CardTypeSwitch'
import { t } from '@/i18n/pl'

afterEach(cleanup)

describe('CardTypeSwitch', () => {
  it('marks the current type and offers the other as a button', () => {
    render(<CardTypeSwitch type="ru_to_pl" onChange={vi.fn()} />)
    expect(screen.getByText(t.typeRuPl).tagName).not.toBe('BUTTON')
    expect(screen.getByText(t.typePlPl).tagName).toBe('BUTTON')
  })

  it('asks for the other type', () => {
    const onChange = vi.fn()
    render(<CardTypeSwitch type="ru_to_pl" onChange={onChange} />)
    fireEvent.click(screen.getByText(t.typePlPl))
    expect(onChange).toHaveBeenCalledWith('pl_to_pl')
  })

  it('asks to switch back', () => {
    const onChange = vi.fn()
    render(<CardTypeSwitch type="pl_to_pl" onChange={onChange} />)
    fireEvent.click(screen.getByText(t.typeRuPl))
    expect(onChange).toHaveBeenCalledWith('ru_to_pl')
  })
})
```

In `lib/capture/pipeline.test.ts`, inside the `listCaptures` describe (or a new one):

```ts
  // The chip offers the type switch only once generation has classified the
  // word as one with forms, so it needs the card's type and kind.
  it('exposes the card type and word kind of each capture', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const [view] = listCaptures(d.db, 0)
    expect(view.cardType).toBe('ru_to_pl')
    expect(view.wordKind).toBe(GENERATED.kind)
  })
```

In `components/CaptureChip.dom.test.tsx`, add `cardType: null, wordKind: null` to `captureItem()`'s defaults, and `onSetType={vi.fn()}` to every existing `<CaptureChip … />` (run `npx tsc --noEmit` to find them). Then add:

```tsx
  it('offers the type switch for a word with forms', () => {
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.getByText(t.typePlPl)).toBeTruthy()
  })

  it('offers no type switch for a phrase, or before a card exists', () => {
    const { rerender } = render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'fraza' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.typePlPl)).toBeNull()
    rerender(
      <CaptureChip
        item={captureItem({ cardId: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.typePlPl)).toBeNull()
  })

  it('asks to make this capture card forms-only', () => {
    const onSetType = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={onSetType}
      />,
    )
    fireEvent.click(screen.getByText(t.typePlPl))
    expect(onSetType).toHaveBeenCalledWith('c1', 'pl_to_pl')
  })

  // Spec §7.1: swipe-left always deleted a chip, but nothing on screen said
  // so — the user asked for a delete that already existed, because they could
  // not see it.
  it('has a visible delete control', () => {
    const onDelete = vi.fn()
    const item = captureItem({ cardId: 'c1' })
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    fireEvent.click(screen.getByText(t.deleteItem))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it('pressing the type switch does not also swipe the chip away', () => {
    const onDelete = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    swipe(screen.getByText(t.typePlPl), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })
```

In `app/dodaj/page.dom.test.tsx`, add `cardType: null, wordKind: null` to `captureRow()`, then add this test to the `AddPage re-recognition` describe:

```tsx
  it('asks the server to make a capture card forms-only, then refreshes', async () => {
    stubMic()
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              captures: [
                {
                  ...captureRow('cap-1', 'generated'),
                  audioMediaId: 'm1',
                  transcript: 'kot',
                  cardId: 'card-1',
                  cardType: 'ru_to_pl',
                  wordKind: 'rzeczownik',
                },
              ],
              card: null,
              duplicateOf: null,
            }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/cards/card-1/typ')
    expect(post?.body).toEqual({ type: 'pl_to_pl' })
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/captures?since=')).length).toBeGreaterThan(1)
  })
```


- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run components/CardTypeSwitch.dom.test.tsx components/CaptureChip.dom.test.tsx lib/capture/pipeline.test.ts app/dodaj/page.dom.test.tsx`
Expected: `CardTypeSwitch` cannot be imported; `view.cardType` is `undefined`; the chip tests find no `tylko formy` or `usuń`; the `/dodaj` test finds no `tylko formy`.

- [ ] **Step 4: Write `components/CardTypeSwitch.tsx`**

```tsx
'use client'
import type { CardType } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

const OPTIONS: ReadonlyArray<{ type: CardType; label: string }> = [
  { type: 'ru_to_pl', label: t.typeRuPl },
  { type: 'pl_to_pl', label: t.typePlPl },
]

/**
 * `karta: ru→pl · tylko formy` (spec 2026-09-18 §7). The current type is
 * plain text, the other a button. Each button stops its own pointer events:
 * on a capture chip the <li> reads pointerdown+pointerup as a tap or a swipe,
 * so without this, pressing the switch could also delete the chip.
 */
export function CardTypeSwitch({ type, onChange }: { type: CardType; onChange: (type: CardType) => void }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-neutral-500">{t.typeLabel}</span>
      {OPTIONS.map((o) =>
        o.type === type ? (
          <span key={o.type} className="font-semibold">
            {o.label}
          </span>
        ) : (
          <button
            key={o.type}
            onClick={() => onChange(o.type)}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            className="underline"
          >
            {o.label}
          </button>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 5: Expose type and kind from `listCaptures`**

In `lib/capture/pipeline.ts`: import `type CardType` from `'../cards/service'` and `type WordKind` from `'../cards/forms'`. Add to `CaptureView`:

```ts
  cardType: CardType | null
  wordKind: WordKind | null
```

In `listCaptures`' `.select({…})` add `cardType: cards.type, wordKind: cards.wordKind,` and in its `.map` add `cardType: c.cardType, wordKind: c.wordKind,`.

- [ ] **Step 6: Add the controls to `components/CaptureChip.tsx`**

Import `CardTypeSwitch`, `type CardType` from `@/lib/cards/service`, and `hasForms` from `@/lib/cards/forms`. Add the prop `onSetType: (cardId: string, type: CardType) => void` to the props destructuring and type. After the language-controls block, add:

```tsx
      {/* Only once generation has classified the word as one with forms:
          before that there is nothing to switch to, and a phrase never has
          forms to drill (spec 2026-09-18 §7.1). */}
      {capture.cardId && capture.cardType && hasForms(capture.wordKind) && (
        <div className="pl-2">
          <CardTypeSwitch type={capture.cardType} onChange={(type) => onSetType(capture.cardId!, type)} />
        </div>
      )}

      {/* Swipe-left always deleted a chip, but nothing on screen said so —
          the user asked for a delete that already existed because they could
          not see it. Swipe stays as a shortcut. */}
      <button
        onClick={() => onDelete(item)}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        className="self-end text-sm text-red-600 underline"
      >
        {t.deleteItem}
      </button>
```

- [ ] **Step 7: Wire `/dodaj`**

In `app/dodaj/page.tsx`, import `type CardType` from `@/lib/cards/service`, and after `relanguage` add:

```tsx
  // Every dictation becomes ru_to_pl; this flips one to drilling the forms of
  // a word already known (spec 2026-09-18 §2), then refreshes so the chip
  // shows the new type without a reload.
  const setType = useCallback(
    (cardId: string, type: CardType) => {
      void fetch(`/api/cards/${cardId}/typ`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type }),
      }).then(() => fetchCaptures())
    },
    [fetchCaptures],
  )
```

and pass `onSetType={setType}` to `<CaptureChip … />`.

- [ ] **Step 8: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: chip offers ru->pl / tylko formy and a visible delete

The type switch appears once generation has classified a word with forms.
Swipe-left always deleted a chip, but invisibly; a visible usuń now does the
same, and swipe stays as a shortcut."
```

---

### Task 10: Card list badge and card detail page

**Files:**
- Modify: `app/fiszki/page.tsx`, `app/fiszki/page.dom.test.tsx`, `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`, `i18n/pl.ts`

**Interfaces:**
- Consumes: `CardTypeSwitch` (Task 9), `FormsView` (Task 8), `parseForms` and `hasForms` (Task 3), `POST /api/cards/:id/typ` (Task 6).

- [ ] **Step 1: Add the strings**

`i18n/pl.ts`, after `typePlPl`:

```ts
  formsBadge: 'formy',
  typeFailed: 'nie udało się zmienić typu karty',
  typeDuplicate: 'taka karta już istnieje',
```

- [ ] **Step 2: Write the failing tests**

In `app/fiszki/page.dom.test.tsx` (add `wordKind: null, formsJson: null` to `cardRow()` if Task 3 did not):

```tsx
  it('badges a forms-only card', async () => {
    stubFetch(() => [
      cardRow({ id: 'a', type: 'pl_to_pl', answerPl: 'kot' }),
      cardRow({ id: 'b', type: 'ru_to_pl', answerPl: 'pies' }),
    ])
    render(<CardsPage />)
    await screen.findByText('pies')
    expect(screen.getAllByText(t.formsBadge)).toHaveLength(1)
    expect(screen.getByText(t.formsBadge).closest('li')).toBe(screen.getByText('kot').closest('li'))
  })
```

In `app/fiszki/[id]/page.dom.test.tsx`, add:

```tsx
  const FORMS = JSON.stringify({
    basic: [{ label: 'M. l.mn.', value: 'koty' }],
    extended: [{ label: 'C.', value: 'kotu · kotom' }],
  })
  const noun = () => cardRow({ answerPl: 'kot', wordKind: 'rzeczownik', formsJson: FORMS })

  it('shows the basic forms, with the extended ones behind a tap', async () => {
    stubFetch(noun)
    render(<CardPage />)
    expect(await screen.findByText('koty')).toBeTruthy()
    expect(screen.queryByText('kotu · kotom')).toBeNull()
    fireEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('kotu · kotom')).toBeTruthy()
  })

  it('offers the type switch for a word with forms, and not for a phrase', async () => {
    stubFetch(noun)
    render(<CardPage />)
    expect(await screen.findByText(t.typePlPl)).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()
    stubFetch(() => cardRow({ wordKind: 'fraza', formsJson: null }))
    render(<CardPage />)
    await screen.findByDisplayValue('złośliwy')
    expect(screen.queryByText(t.typePlPl)).toBeNull()
  })

  it('switches the card to forms-only and shows the result', async () => {
    let type: 'ru_to_pl' | 'pl_to_pl' = 'ru_to_pl'
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (method === 'POST') type = 'pl_to_pl'
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: { ...noun(), type }, captureId: null, duplicateOf: null }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/cards/c1/typ',
      method: 'POST',
      body: { type: 'pl_to_pl' },
    })
    expect((await screen.findByText(t.typePlPl)).tagName).not.toBe('BUTTON')
  })

  it('says so when that card already exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              (init?.method ?? 'GET') === 'GET'
                ? { card: noun(), captureId: null }
                : { card: noun(), duplicateOf: 'other' },
            ),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeDuplicate)).toBeTruthy()
  })

  it('shows an error when the switch is refused', async () => {
    stubFailingWrites(noun, 400)
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeFailed)).toBeTruthy()
  })
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run app/fiszki`
Expected: no `formy` badge; no `koty`; no `tylko formy`.

- [ ] **Step 4: Implement the list badge**

In `app/fiszki/page.tsx`, inside the badges `<span>`, add before the `needs_input` badge:

```tsx
                {c.type === 'pl_to_pl' && <span className="text-sky-700">{t.formsBadge}</span>}
```

- [ ] **Step 5: Implement the detail page**

In `app/fiszki/[id]/page.tsx`: import `CardTypeSwitch`, `FormsView`, `hasForms` and `parseForms` from `@/lib/cards/forms`, and `type CardType` from `@/lib/cards/service`. Add state:

```tsx
  const [typeError, setTypeError] = useState(false)
  const [typeDuplicate, setTypeDuplicate] = useState(false)
```

Add the handler after `regenerate`:

```tsx
  // A 200 can still carry a clash: the card is left as it was and duplicateOf
  // names the card that already exists (spec 2026-09-18 §6).
  async function setType(type: CardType) {
    const res = await fetch(`/api/cards/${id}/typ`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
    })
    if (!res.ok) {
      setTypeError(true)
      return
    }
    setTypeError(false)
    const body = (await res.json()) as { card: CardRow; duplicateOf: string | null }
    setCard(body.card)
    setTypeDuplicate(body.duplicateOf !== null)
  }
```

After the `<audio …/>` element, add:

```tsx
      <FormsView key={card.id} forms={parseForms(card.formsJson)} />

      {hasForms(card.wordKind) && <CardTypeSwitch type={card.type} onChange={(type) => void setType(type)} />}
```

With the other messages at the bottom, add:

```tsx
      {typeError && <p className="text-sm text-red-600">{t.typeFailed}</p>}
      {typeDuplicate && <p className="text-sm text-amber-600">{t.typeDuplicate}</p>}
```

- [ ] **Step 6: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: card list badges forms-only cards; detail page shows forms and the type switch"
```

---

### Task 11: Drop the database, deploy, verify against the real model

This task runs on the VM and against live providers. It is done by the controller, not delegated. The deploy details are in memory (`fiszki-vm-deployment`): VM `vm-pol`, zone `europe-central2-a`, code in `/opt/fiszki`, database `/mnt/fiszki/fiszki.db`, secrets in root-only `/etc/fiszki.env`.

- [ ] **Step 1: Gates on the finished branch**

`npx tsc --noEmit`, `npx vitest run`, `npm run build` — all clean. Stop here if not.

- [ ] **Step 2: Deploy, moving the database aside**

Dependencies changed (`sharp` removed), so this deploy runs `npm ci`, not only `npm run build`. On the VM, as root:

```bash
systemctl stop fiszki.service
cd /mnt/fiszki
for f in fiszki.db fiszki.db-wal fiszki.db-shm; do
  [ -e "$f" ] && mv "$f" "$f.pre-forms-2026-09-18"
done
cd /opt/fiszki
tar -xzf /tmp/fiszki.tar.gz -C /opt/fiszki
rm -f migrations/002-deleted-at.sql     # tar adds files, it never removes them
npm ci --no-audit --no-fund
npm run build
chown -R fiszki:fiszki /opt/fiszki /mnt/fiszki
systemctl start fiszki.service
sleep 6 && systemctl is-active fiszki.service
sqlite3 /mnt/fiszki/fiszki.db "select name from _migrations;"
```

Expected: `active`, and exactly `001-init.sql`. **Also delete, on the VM, every file this plan deleted** (`app/obrazki`, `app/api/images`, `app/api/cards/[id]/formy`, `lib/media/image.ts`, `components/FormsTable.tsx`, `lib/markdown.ts`, `lib/cards/display.ts` and their tests): extracting a tarball over the old tree never removes anything, and a stale route file would still build and serve.

- [ ] **Step 3: Smoke check**

`npm run check-providers` (env loaded as root, run as `fiszki`). Expected: three `OK`, and Gemini's detail line shows `kind=rzeczownik` with a non-empty `basic`.

- [ ] **Step 4: The word set, against the real model**

Run this on the VM from `/opt/fiszki` (as `fiszki`, env loaded), and show the user the full output:

```ts
import { getGenerator } from './lib/generate/index.ts'

const WORDS = [
  'kot', 'nożyczki', 'robić', 'zrobić', 'przyzwyczaić się', 'szybki', 'szybko',
  'zdrów jak ryba', 'kleszczowe zapalenie mózgu', 'cześć', 'склеп',
]

for (const word of WORDS) {
  const started = Date.now()
  try {
    const c = await getGenerator().fromDictation(word)
    console.log(`\n=== ${word}  (${Date.now() - started}ms)  kind=${c.kind}`)
    console.log(`    prompt_ru=${c.prompt_ru}  answer_pl=${c.answer_pl}`)
    for (const r of c.forms_basic) console.log(`    basic     ${r.label}: ${r.value}`)
    for (const r of c.forms_extended) console.log(`    extended  ${r.label}: ${r.value}`)
  } catch (err) {
    console.log(`\n=== ${word}  (${Date.now() - started}ms)  FAILED: ${(err as Error).message}`)
  }
}
```

Check against spec §11's table: `nożyczki` has no singular rows; `zrobić` shows `cz. przyszły` and no `-ący` participle; `przyzwyczaić się` is `czasownik`; `zdrów jak ryba` and `kleszczowe zapalenie mózgu` are `fraza` with no forms; `cześć` is `inne`; `склеп` has `prompt_ru` Russian and a Polish `answer_pl` with noun forms. Report every deviation to the user rather than judging the Polish yourself — they are the authority on it. Report the latencies.

- [ ] **Step 5: Pages and one real card**

Log in over the tailnet URL and confirm `/dodaj`, `/fiszki`, `/powtorki` return 200 and `/obrazki` returns 404. Ask the user to dictate one noun and one verb and check the chip, the detail page and the review screen on the phone.

- [ ] **Step 6: Update memory**

Record in `fiszki-vm-deployment` that the database was replaced on 2026-09-18 and where the old one was moved.
