# Topic Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Describe a situation, get rounds of Polish words and phrases (each with a Russian gloss) proposed for it, strike out what you don't want, and have the rest become cards under one topic that can be switched off as a whole.

**Architecture:** Two new tables, `topics` and `suggestions`, plus nullable `topic_id` columns on `cards`, `captures` and `generation_jobs`. A new `suggest` job kind runs in the existing queue ahead of other kinds and writes a round of `proposed` suggestions. Accepting a round turns each kept item into an audio-less capture with an ordinary `new` job, so card generation, dedup, pending lists and failure handling are the existing ones. `lib/topics/rounds.ts` holds the pure rules; `lib/topics/service.ts` holds everything that touches the database.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, SQLite (better-sqlite3) + Drizzle, hand-written SQL migrations, Vitest + jsdom, Gemini on Vertex (`@google/genai`), Google Speech-to-Text v2.

**Spec:** `docs/superpowers/specs/2026-09-18-topic-generation-design.md` — read it before any task. Where this plan and the spec disagree, the spec wins; stop and report. One refinement the spec leaves implicit: dictating the context needs a language, because Speech-to-Text takes exactly one (see `DictationLang` in `lib/transcribe/index.ts`), so the new-topic screen has a `po rosyjsku · po polsku` toggle defaulting to Russian (Task 10).

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, `npm run build` exits 0. Vitest does not typecheck. Read each gate's output before committing; never chain a commit after a test command with `&&`.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed. A test that cannot fail if the behaviour is removed is a defect — say so if one passes before your change.
- **Every comment must be true when committed**, including comments your change makes false in files you touch.
- **Migrations are append-only.** This plan adds exactly one, `migrations/003-topics.sql`. Never edit `001` or `002`. The deployed database holds real cards.
- **Clock is injected:** every stateful function takes `now: Date`.
- **No HTTP handler calls Gemini.** Speech-to-Text stays synchronous in requests; every Gemini call happens in a queue job.
- **Exact values:** counts `5 | 10 | 20`, default `10`; mixes `mieszane | slowa | frazy` with word share `0.5 | 0.8 | 0.2`; request size `ceil(count × 1.5)`; suggestion kinds `slowo | fraza`; suggestion statuses `proposed | accepted | rejected`; `MAX_ATTEMPTS_NON_RETRYABLE` stays `3`.
- **Job kinds:** `new | regenerate | rerecognized | suggest`. `suggest` jobs are taken before any other due job.
- **All UI strings live in `i18n/pl.ts`, in Polish.** No Cyrillic in chrome (`i18n/pl.test.ts` enforces it).
- **Do not change `FISZKI_MODEL`.**
- Adding `cards.topic_id` makes `topicId` a required key of `CardRow`. Every `CardRow` literal in tests (search for `lastReview: null`) gains `topicId: null`; fix them in the task that adds the column.

## File map

| File | Responsibility | Task |
|---|---|---|
| `lib/topics/rounds.ts` (new) | pure: kinds, mixes, request size, mix split, round dedup | 1 |
| `migrations/003-topics.sql` (new), `lib/db/schema.ts` | tables and columns | 2 |
| `lib/generate/index.ts` | enum in array rows, `Suggester`, meaning in `fromDictation` | 3 |
| `lib/queue/jobs.ts`, `lib/topics/service.ts` (new), `lib/capture/pipeline.ts`, `lib/queue/worker.ts` | the `suggest` job | 4 |
| `lib/topics/service.ts`, `lib/cards/service.ts`, `lib/capture/pipeline.ts` | accepting a round; topic cards | 5 |
| `lib/topics/service.ts` | create, list, view, update, retry | 6 |
| `lib/review/queue.ts` | suspended topics leave review | 7 |
| `app/api/topics/**` (new) | endpoints | 8 |
| `app/api/cards/**`, `app/fiszki/**` | topic name on cards | 9 |
| `components/Nav.tsx`, `components/RoundSettings.tsx` (new), `app/tematy/page.tsx` (new), `app/tematy/nowy/page.tsx` (new) | list and new topic | 10 |
| `app/tematy/[id]/page.tsx` (new) | the topic page | 11 |
| `scripts/try-suggestions.ts` (new) | live prompt check | 12 |

---

### Task 1: Pure round rules

**Files:**
- Create: `lib/topics/rounds.ts`, `lib/topics/rounds.test.ts`

**Interfaces:**
- Produces:
  - `SUGGESTION_KINDS = ['slowo', 'fraza'] as const`, `type SuggestionKind`
  - `MIXES = ['mieszane', 'slowa', 'frazy'] as const`, `type Mix`
  - `COUNTS = [5, 10, 20] as const`, `DEFAULT_COUNT = 10`
  - `type RoundParams = { count: number; mix: Mix }`
  - `requestSize(count: number): number`
  - `mixTarget(n: number, mix: Mix): { words: number; phrases: number }`
  - `type SuggestedItem = { answer_pl: string; gloss_ru: string; kind: SuggestionKind }`
  - `pickRound(items: readonly SuggestedItem[], taken: ReadonlySet<string>, count: number): SuggestedItem[]` — `taken` holds `answerKey` values.

- [ ] **Step 1: Write the failing tests** — `lib/topics/rounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mixTarget, pickRound, requestSize, type SuggestedItem } from './rounds'

const item = (answer_pl: string, kind: 'slowo' | 'fraza' = 'slowo'): SuggestedItem => ({
  answer_pl, gloss_ru: 'перевод', kind,
})

describe('requestSize', () => {
  // Half as many again as the round needs, so dedup can drop some and still
  // leave a full round (spec §5).
  it('asks for count × 1.5, rounded up', () => {
    expect(requestSize(5)).toBe(8)
    expect(requestSize(10)).toBe(15)
    expect(requestSize(20)).toBe(30)
  })
})

describe('mixTarget', () => {
  it('splits a request by the mix', () => {
    expect(mixTarget(15, 'mieszane')).toEqual({ words: 8, phrases: 7 })
    expect(mixTarget(15, 'slowa')).toEqual({ words: 12, phrases: 3 })
    expect(mixTarget(15, 'frazy')).toEqual({ words: 3, phrases: 12 })
  })
})

describe('pickRound', () => {
  it('keeps the first `count` items in order', () => {
    const got = pickRound([item('a'), item('b'), item('c')], new Set(), 2)
    expect(got.map((i) => i.answer_pl)).toEqual(['a', 'b'])
  })

  it('drops anything already taken, compared by answer key', () => {
    const got = pickRound([item('Gorączka!'), item('katar')], new Set(['gorączka']), 10)
    expect(got.map((i) => i.answer_pl)).toEqual(['katar'])
  })

  it('drops a repeat within the same response', () => {
    const got = pickRound([item('katar'), item('Katar.'), item('kaszel')], new Set(), 10)
    expect(got.map((i) => i.answer_pl)).toEqual(['katar', 'kaszel'])
  })

  // Diacritics are never folded (lib/cards/answer-key.ts): ł and l are
  // different letters, so these are two different words.
  it('does not treat a diacritic variant as a repeat', () => {
    const got = pickRound([item('łza'), item('lza')], new Set(), 10)
    expect(got).toHaveLength(2)
  })

  it('trims text and skips empty items', () => {
    const got = pickRound([{ answer_pl: '  ', gloss_ru: 'x', kind: 'slowo' }, { answer_pl: ' katar ', gloss_ru: ' насморк ', kind: 'slowo' }], new Set(), 10)
    expect(got).toEqual([{ answer_pl: 'katar', gloss_ru: 'насморк', kind: 'slowo' }])
  })

  it('returns a short round rather than inventing items', () => {
    expect(pickRound([item('a')], new Set(), 10)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run lib/topics/rounds.test.ts`
Expected: FAIL — cannot resolve `./rounds`.

- [ ] **Step 3: Implement** — `lib/topics/rounds.ts`:

```ts
import { answerKey } from '../cards/answer-key'

/**
 * The pure rules of a topic's rounds (spec 2026-09-18-topic-generation §2, §5).
 * Nothing here touches the database or the model.
 */

/** ASCII, like WORD_KINDS's `przyslowek`; the screen shows `słowo`. */
export const SUGGESTION_KINDS = ['slowo', 'fraza'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const MIXES = ['mieszane', 'slowa', 'frazy'] as const
export type Mix = (typeof MIXES)[number]

export const COUNTS = [5, 10, 20] as const
export const DEFAULT_COUNT = 10

export type RoundParams = { count: number; mix: Mix }

const WORD_SHARE: Record<Mix, number> = { mieszane: 0.5, slowa: 0.8, frazy: 0.2 }

/** How many items to ask the model for, leaving room for dedup to drop some. */
export function requestSize(count: number): number {
  return Math.ceil(count * 1.5)
}

export function mixTarget(n: number, mix: Mix): { words: number; phrases: number } {
  const words = Math.round(n * WORD_SHARE[mix])
  return { words, phrases: n - words }
}

export type SuggestedItem = { answer_pl: string; gloss_ru: string; kind: SuggestionKind }

/**
 * The round that is shown: the model's items in its order (most useful first),
 * minus empty ones, anything whose answer key is in `taken` (the deck and the
 * topic's history), and repeats within the response; at most `count` of them.
 * A shorter round is fine — it is never padded.
 */
export function pickRound(items: readonly SuggestedItem[], taken: ReadonlySet<string>, count: number): SuggestedItem[] {
  const seen = new Set(taken)
  const out: SuggestedItem[] = []
  for (const it of items) {
    if (out.length === count) break
    const answer = it.answer_pl.trim()
    if (!answer) continue
    const key = answerKey(answer)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ answer_pl: answer, gloss_ru: it.gloss_ru.trim(), kind: it.kind })
  }
  return out
}
```

- [ ] **Step 4: Run the tests** — `npx vitest run lib/topics/rounds.test.ts` — PASS.
- [ ] **Step 5: Gates, then commit**

```bash
git add lib/topics/rounds.ts lib/topics/rounds.test.ts
git commit -m "feat: pure rules for topic rounds"
```

---

### Task 2: Migration 003 and schema

**Files:**
- Create: `migrations/003-topics.sql`
- Modify: `lib/db/schema.ts`, `lib/db/schema-shape.test.ts`, every test file with a `CardRow` literal (search `lastReview: null`)

**Interfaces:**
- Consumes: `SUGGESTION_KINDS` from Task 1.
- Produces: Drizzle tables `topics` (`id, name, context, suspendedAt, createdAt`) and `suggestions` (`id, topicId, round, answerPl, glossRu, kind, status, captureId, createdAt`); `cards.topicId`, `captures.topicId`, `captures.glossRu`, `generationJobs.topicId`, `generationJobs.paramsJson` — all `string | null`.

- [ ] **Step 1: Write the failing tests** — in `lib/db/schema-shape.test.ts`:

Change the migration list expectation to:

```ts
    expect(names).toEqual(['001-init.sql', '002-generation-queue.sql', '003-topics.sql'])
```

Change the `generation_jobs` column expectation to:

```ts
    expect(cols).toEqual([
      'id', 'kind', 'capture_id', 'card_id', 'status', 'attempts', 'failures',
      'next_attempt_at', 'last_error', 'created_at', 'finished_at', 'topic_id', 'params_json',
    ])
```

Add:

```ts
  it('has topics and suggestions, and topic columns on cards, captures and jobs', () => {
    const { sqlite } = createTestDb()
    const cols = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('topics')).toEqual(['id', 'name', 'context', 'suspended_at', 'created_at'])
    expect(cols('suggestions')).toEqual([
      'id', 'topic_id', 'round', 'answer_pl', 'gloss_ru', 'kind', 'status', 'capture_id', 'created_at',
    ])
    expect(cols('cards')).toContain('topic_id')
    expect(cols('captures')).toEqual(expect.arrayContaining(['topic_id', 'gloss_ru']))
  })

  // DELETE /api/captures/:id hard-deletes a recording with no card. A
  // suggestion must not block that, and must not point at a missing row.
  it('clears a suggestion’s capture when the capture is deleted', () => {
    const { sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO topics (id, context, created_at) VALUES ('t1', 'x', 1)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'queued', 1)`).run()
    sqlite
      .prepare(`INSERT INTO suggestions (id, topic_id, round, answer_pl, gloss_ru, kind, status, capture_id, created_at)
                VALUES ('s1', 't1', 1, 'katar', 'насморк', 'slowo', 'accepted', 'c1', 1)`)
      .run()
    sqlite.prepare(`DELETE FROM captures WHERE id = 'c1'`).run()
    expect(sqlite.prepare(`SELECT capture_id FROM suggestions`).get()).toEqual({ capture_id: null })
  })

  it('upgrades a database that has 002 applied, keeping its cards', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1), ('002-generation-queue.sql', 1)`).run()
    sqlite
      .prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due, stability,
                difficulty, elapsed_days, scheduled_days, reps, lapses, state)
                VALUES ('k1', 'ru_to_pl', 'kot', 'kot', 'ready', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)`)
      .run()

    migrate(sqlite)

    expect(sqlite.prepare('SELECT id, topic_id FROM cards').all()).toEqual([{ id: 'k1', topic_id: null }])
  })
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run lib/db/schema-shape.test.ts` — FAIL: no `003-topics.sql`, no `topics` table.

- [ ] **Step 3: Write the migration** — `migrations/003-topics.sql`:

```sql
-- Topics (docs/superpowers/specs/2026-09-18-topic-generation-design.md §3).
-- Append-only: the deployed database holds real cards. Every change here is
-- additive, and every new column on an existing table is nullable.

-- A situation you asked vocabulary for. Its cards can be switched off as a
-- whole via suspended_at, independently of each card's own suspended_at.
CREATE TABLE topics (
  id            TEXT PRIMARY KEY,
  name          TEXT,              -- NULL until the first round names it
  context       TEXT NOT NULL,
  suspended_at  INTEGER,
  created_at    INTEGER NOT NULL
);

-- Every item ever proposed for a topic, kept so later rounds never repeat one.
CREATE TABLE suggestions (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  round       INTEGER NOT NULL,
  answer_pl   TEXT NOT NULL,
  gloss_ru    TEXT NOT NULL,
  kind        TEXT NOT NULL,       -- 'slowo' | 'fraza'
  status      TEXT NOT NULL,       -- 'proposed' | 'accepted' | 'rejected'
  -- The capture an accepted item became. SET NULL: a capture with no card can
  -- be hard-deleted, and that must not be blocked by, or dangle from, this row.
  capture_id  TEXT REFERENCES captures(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX suggestions_topic_round ON suggestions(topic_id, round);

ALTER TABLE cards ADD COLUMN topic_id TEXT REFERENCES topics(id);

-- An accepted suggestion becomes a capture with no audio; these two carry
-- its topic and the Russian meaning the card should be built around.
ALTER TABLE captures ADD COLUMN topic_id TEXT REFERENCES topics(id);
ALTER TABLE captures ADD COLUMN gloss_ru TEXT;

-- For kind 'suggest': the topic, and {"round","count","mix"}.
ALTER TABLE generation_jobs ADD COLUMN topic_id TEXT REFERENCES topics(id);
ALTER TABLE generation_jobs ADD COLUMN params_json TEXT;
```

- [ ] **Step 4: Mirror it in Drizzle** — `lib/db/schema.ts`:

Add the import:

```ts
import { SUGGESTION_KINDS } from '../topics/rounds'
```

Add `topicId: text('topic_id'),` as the last field of `cards` (after `lastReview`), `topicId: text('topic_id'),` and `glossRu: text('gloss_ru'),` as the last fields of `captures`, and `topicId: text('topic_id'),` and `paramsJson: text('params_json'),` as the last fields of `generationJobs`. Then add:

```ts
export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  name: text('name'),
  context: text('context').notNull(),
  suspendedAt: integer('suspended_at'),
  createdAt: integer('created_at').notNull(),
})

export const suggestions = sqliteTable('suggestions', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull(),
  round: integer('round').notNull(),
  answerPl: text('answer_pl').notNull(),
  glossRu: text('gloss_ru').notNull(),
  kind: text('kind', { enum: SUGGESTION_KINDS }).notNull(),
  status: text('status', { enum: ['proposed', 'accepted', 'rejected'] }).notNull(),
  captureId: text('capture_id'),
  createdAt: integer('created_at').notNull(),
})
```

Leave `generationJobs.kind`'s enum alone; `suggest` joins it in Task 4, together with its handler.

- [ ] **Step 5: Fix `CardRow` literals.** Run `npx tsc --noEmit`; add `topicId: null` to every `CardRow` literal it flags (e.g. `cardRow()` in `app/fiszki/page.dom.test.tsx`).
- [ ] **Step 6: Run the tests** — `npx vitest run lib/db` — PASS.
- [ ] **Step 7: Gates, then commit**

```bash
git add migrations/003-topics.sql lib/db/schema.ts lib/db/schema-shape.test.ts <each test file you fixed>
git commit -m "feat: migration 003 — topics and suggestions"
```

---

### Task 3: The generator — enum rows, `Suggester`, meaning

**Files:**
- Modify: `lib/generate/index.ts`, `lib/generate/index.test.ts`

**Interfaces:**
- Consumes: `SUGGESTION_KINDS` (Task 1).
- Produces:
  - `type Meaning = { glossRu: string; context: string }`
  - `Generator.fromDictation(transcript: string, meaning?: Meaning): Promise<GeneratedCard>`
  - `dictationMessage(text: string, meaning?: Meaning): string`
  - `SuggestionSchema`, `type Suggestion = { topic_name: string; items: SuggestedItem[] }`
  - `type SuggestInput = { context: string; count: number; words: number; phrases: number; exclude: readonly string[] }`
  - `interface Suggester { suggest(input: SuggestInput): Promise<Suggestion> }`
  - `suggestMessage(input: SuggestInput): string`
  - `geminiSuggester(opts?: { generate?: GenerateFn; model?: string }): Suggester`, `getSuggester(): Suggester`

- [ ] **Step 1: Write the failing tests** — append to `lib/generate/index.test.ts` (extend its import with `SuggestionSchema, dictationMessage, geminiSuggester, suggestMessage`):

```ts
describe('responseSchemaFor with an enum inside array rows', () => {
  // Type-level change: before it, this schema does not typecheck
  // (RowSchema allowed strings only). tsc is the failing gate here.
  it('emits the enum for a row field', () => {
    const out = responseSchemaFor(SuggestionSchema) as {
      properties: { items: { items: { properties: Record<string, unknown> } } }
    }
    expect(out.properties.items.items.properties.kind).toEqual({
      type: 'STRING', enum: ['slowo', 'fraza'], description: expect.any(String),
    })
  })
})

describe('dictationMessage', () => {
  it('is unchanged for a plain dictation', () => {
    expect(dictationMessage('kot')).toBe('Продиктовано: «kot»\n\nСделай карточку.')
  })

  it('names the intended meaning and the situation for a topic item', () => {
    const m = dictationMessage('gorączka', { glossRu: 'температура, жар', context: 'u lekarza z dzieckiem' })
    expect(m).toContain('«температура, жар»')
    expect(m).toContain('«u lekarza z dzieckiem»')
    expect(m.endsWith('Сделай карточку.')).toBe(true)
  })
})

describe('geminiGenerator with a meaning', () => {
  it('sends the meaning in the user message, not the system prompt', async () => {
    const generate = ok(FULL)
    await make(generate).fromDictation('złośliwy', { glossRu: 'злобный', context: 'w pracy' })
    const req = generate.mock.calls[0][0]
    expect(req.contents[0].parts[0].text).toContain('«злобный»')
    expect(req.config.systemInstruction).not.toContain('злобный')
  })
})

const SUGGESTION = {
  topic_name: 'U lekarza z dzieckiem',
  items: [{ answer_pl: 'gorączka', gloss_ru: 'температура, жар', kind: 'slowo' }],
}

describe('suggestMessage', () => {
  it('states the situation, the split and the exclusions', () => {
    const m = suggestMessage({ context: 'u lekarza', count: 15, words: 8, phrases: 7, exclude: ['katar', 'kaszel'] })
    expect(m).toContain('«u lekarza»')
    expect(m).toContain('15')
    expect(m).toContain('8')
    expect(m).toContain('7')
    expect(m).toContain('katar; kaszel')
  })

  it('says so when there is nothing to exclude', () => {
    expect(suggestMessage({ context: 'x', count: 8, words: 4, phrases: 4, exclude: [] })).toContain('ничего')
  })
})

describe('geminiSuggester', () => {
  const suggester = (generate: ReturnType<typeof ok>) =>
    geminiSuggester({ generate: generate as never, model: 'gemini-pro-test' })

  it('returns the parsed suggestion', async () => {
    const generate = ok(SUGGESTION)
    const got = await suggester(generate).suggest({ context: 'u lekarza', count: 15, words: 8, phrases: 7, exclude: [] })
    expect(got).toEqual(SUGGESTION)
    expect(generate.mock.calls[0][0].config.responseSchema.properties.items.type).toBe('ARRAY')
  })

  it('refuses an empty context without calling the model', async () => {
    const generate = ok(SUGGESTION)
    await expect(
      suggester(generate).suggest({ context: '  ', count: 15, words: 8, phrases: 7, exclude: [] }),
    ).rejects.toMatchObject({ name: 'GenerationError', retryable: false })
    expect(generate).not.toHaveBeenCalled()
  })

  it('classifies a 429 as retryable, like card generation', async () => {
    const generate = vi.fn().mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }))
    await expect(
      suggester(generate as never).suggest({ context: 'x', count: 8, words: 4, phrases: 4, exclude: [] }),
    ).rejects.toMatchObject({ retryable: true })
  })

  it('rejects a payload with an unknown kind', async () => {
    const generate = ok({ ...SUGGESTION, items: [{ answer_pl: 'a', gloss_ru: 'b', kind: 'rzeczownik' }] })
    await expect(
      suggester(generate).suggest({ context: 'x', count: 8, words: 4, phrases: 4, exclude: [] }),
    ).rejects.toMatchObject({ retryable: false })
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run lib/generate` — FAIL: the new exports do not exist.

- [ ] **Step 3: Implement.** In `lib/generate/index.ts`:

(a) Import `SUGGESTION_KINDS`:

```ts
import { SUGGESTION_KINDS } from '../topics/rounds'
```

(b) Widen the row type and its comment. Replace `type RowSchema = z.ZodObject<Record<string, z.ZodString>>` with:

```ts
type RowSchema = z.ZodObject<Record<string, z.ZodString | z.ZodEnum>>
```

and update `responseSchemaFor`'s doc comment: the third shape is now "an array of objects whose fields are strings or string enums (form rows; suggestion items)".

(c) After `GeneratedCardSchema`, add:

```ts
export const SuggestionSchema = z.object({
  topic_name: z.string().describe('Short Polish name of the situation, 2–5 words, e.g. "U lekarza z dzieckiem"'),
  items: z
    .array(
      z.object({
        answer_pl: z.string().describe('Polish word in dictionary form, or a phrase, with diacritics'),
        gloss_ru: z.string().describe('Short Russian gloss: one to three comma-separated senses'),
        kind: z.enum(SUGGESTION_KINDS).describe('slowo for a single word (a się verb counts as one), fraza for anything longer'),
      }),
    )
    .describe('Most useful first'),
})
export type Suggestion = z.infer<typeof SuggestionSchema>
```

(d) After `SYSTEM`, add the suggestion prompt:

```ts
const SUGGEST_SYSTEM = `Ты помогаешь взрослому человеку, который уже свободно читает и говорит по-польски, подготовиться к конкретной ситуации. Он описывает ситуацию, а ты предлагаешь польскую лексику, которая ему там понадобится.

Правила:
- Человек знает польский хорошо. Не предлагай базовую повседневную лексику (для визита к врачу — не «lekarz», «dziecko», «chory»). Предлагай то, что специфично для этой ситуации и чего носителю другого языка, скорее всего, не хватает: термины, устойчивые сочетания, типичные вопросы и ответы.
- kind:
  - slowo — одно слово в словарной форме; возвратный глагол с «się» — тоже одно слово;
  - fraza — всё длиннее одного слова: сочетание, реплика, вопрос, ответ. Фразы — то, что реально говорят или слышат в этой ситуации, а не книжные предложения.
- answer_pl — по-польски, с правильной диакритикой.
- gloss_ru — короткий перевод на русский: одно-три значения через запятую, в том смысле, который нужен в этой ситуации.
- Никогда не используй английский язык — never use English anywhere in the output.
- Соблюдай запрошенное количество и соотношение слов и фраз.
- Не повторяй ничего из списка «уже предлагалось» — ни то же слово, ни его другую форму.
- Упорядочи по полезности в этой ситуации: самое нужное — первым.
- topic_name — короткое польское название ситуации, 2–5 слов, например «U lekarza z dzieckiem».`
```

(e) Replace everything from `export interface Generator {` to the end of the file, keeping `GenerateFn` and `resolveModel` (with their comments) exactly as they are, so it reads:

```ts
/** For a topic item: the Russian sense the card must be built around, and the situation. */
export type Meaning = { glossRu: string; context: string }

export interface Generator {
  fromDictation(transcript: string, meaning?: Meaning): Promise<GeneratedCard>
}

export type SuggestInput = {
  context: string
  /** How many items to ask for (already enlarged for dedup; lib/topics/rounds.ts requestSize). */
  count: number
  words: number
  phrases: number
  /** Every answer_pl the topic has ever been offered. */
  exclude: readonly string[]
}

export interface Suggester {
  suggest(input: SuggestInput): Promise<Suggestion>
}

// ... GenerateFn and resolveModel unchanged ...

type Run = <T extends z.ZodObject<Record<string, SupportedField>>>(
  schema: T,
  systemInstruction: string,
  parts: unknown[],
) => Promise<z.infer<T>>

/**
 * One structured Gemini call, shared by card generation and suggestions so
 * both classify failures the same way (retryable request errors; unusable
 * responses are not).
 */
function geminiRunner(opts: { generate?: GenerateFn; model?: string }): Run {
  const model = resolveModel(opts.model)

  const generate: GenerateFn =
    opts.generate ??
    (async (req) => {
      // [move the existing comments and body of the default generate here unchanged]
    })

  async function run<T extends z.ZodObject<Record<string, SupportedField>>>(
    schema: T,
    systemInstruction: string,
    parts: unknown[],
  ): Promise<z.infer<T>> {
    // [move the existing body of run here unchanged]
  }

  return run
}

/** The user message for a card. Without a meaning it is exactly what a dictation always sent. */
export function dictationMessage(text: string, meaning?: Meaning): string {
  const lines = [`Продиктовано: «${text}»`]
  if (meaning) {
    lines.push(
      `Имеется в виду значение: «${meaning.glossRu}». Ситуация, для которой нужна карточка: «${meaning.context}».`,
    )
  }
  lines.push('Сделай карточку.')
  return lines.join('\n\n')
}

export function geminiGenerator(opts: { generate?: GenerateFn; model?: string } = {}): Generator {
  const run = geminiRunner(opts)
  return {
    async fromDictation(transcript, meaning) {
      const text = transcript.trim()
      if (!text) throw new GenerationError('empty transcript')
      // Deliberately does not name the language. The transcript may be Polish
      // or Russian and the alphabet already says which; claiming one here
      // would be asserting something false in the one place the model cannot
      // check it against the audio.
      return run(GeneratedCardSchema, SYSTEM, [{ text: dictationMessage(text, meaning) }])
    },
  }
}

export function suggestMessage(input: SuggestInput): string {
  const exclude = input.exclude.length > 0 ? input.exclude.join('; ') : 'ничего'
  return [
    `Ситуация: «${input.context}»`,
    `Нужно ${input.count}: примерно ${input.words} отдельных слов и ${input.phrases} фраз.`,
    `Уже предлагалось, не повторяй: ${exclude}`,
  ].join('\n\n')
}

export function geminiSuggester(opts: { generate?: GenerateFn; model?: string } = {}): Suggester {
  const run = geminiRunner(opts)
  return {
    async suggest(input) {
      const context = input.context.trim()
      if (!context) throw new GenerationError('empty context')
      return run(SuggestionSchema, SUGGEST_SYSTEM, [{ text: suggestMessage({ ...input, context }) }])
    },
  }
}

export function getGenerator(): Generator {
  return geminiGenerator()
}

export function getSuggester(): Suggester {
  return geminiSuggester()
}
```

The two bracketed lines are moves of existing code, not new code: cut the default `generate` arrow body and the `run` body out of today's `geminiGenerator` and paste them unchanged.

- [ ] **Step 4: Run the tests** — `npx vitest run lib/generate` — PASS, including every pre-existing test (the plain-dictation message is byte-identical).
- [ ] **Step 5: Gates, then commit**

```bash
git add lib/generate/index.ts lib/generate/index.test.ts
git commit -m "feat: a suggestion call, and a topic item's meaning in the card prompt"
```

---

### Task 4: The `suggest` job

**Files:**
- Create: `lib/topics/service.ts`, `lib/topics/service.test.ts`
- Modify: `lib/db/schema.ts`, `lib/queue/jobs.ts`, `lib/queue/jobs.test.ts`, `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `lib/queue/worker.ts`

**Interfaces:**
- Consumes: `topics`, `suggestions`, `generationJobs.topicId/paramsJson` (Task 2); `Suggester` (Task 3); `requestSize`, `mixTarget`, `pickRound`, `MIXES`, `RoundParams` (Task 1).
- Produces:
  - `JobKind` gains `'suggest'`; `enqueueJob(db, { kind, captureId?, cardId?, topicId?, paramsJson? }, now)`
  - `lib/topics/service.ts`: `type TopicRow`, `type SuggestionRow`, `activeSuggestJob(db, topicId): JobRow | undefined`, `latestRound(db, topicId): number` (0 if none), `enqueueSuggest(db, topicId, params: RoundParams, now): string | null`, `parseRoundJob(paramsJson: string | null): { round: number } & RoundParams`, `runSuggest(deps: { db: Db; suggester: Suggester }, job: JobRow, now: Date): Promise<void>`
  - `jobHandlers(deps: CaptureDeps & { suggester: Suggester })`; worker `Providers` gains `suggester`.

- [ ] **Step 1: Write the failing queue test** — in `lib/queue/jobs.test.ts`, add `suggest: h` to the object built in `fakeHandlers`, and add inside `describe('runNextJob')`:

```ts
  // A round is something you are watching the screen for; a card is not
  // (spec 2026-09-18-topic-generation §6.1).
  it('takes a due suggest job before an older job of another kind', async () => {
    const { db } = createTestDb()
    const older = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const round = enqueueJob(db, { kind: 'suggest', paramsJson: '{}' }, at(5))
    const { handlers, run } = fakeHandlers()
    await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)
    expect(run.mock.calls[0][0].id).toBe(round)
    expect(job(db, older).status).toBe('queued')
  })

  it('still respects next_attempt_at for a suggest job', async () => {
    const { db } = createTestDb()
    const older = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const round = enqueueJob(db, { kind: 'suggest', paramsJson: '{}' }, at(5))
    db.update(generationJobs).set({ nextAttemptAt: T + 1_000 }).where(eq(generationJobs.id, round)).run()
    const { handlers, run } = fakeHandlers()
    await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)
    expect(run.mock.calls[0][0].id).toBe(older)
  })
```

- [ ] **Step 2: Write the failing service tests** — `lib/topics/service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, generationJobs, suggestions, topics } from '../db/schema'
import { createCard, deleteCard } from '../cards/service'
import type { Suggestion, Suggester } from '../generate'
import { enqueueJob } from '../queue/jobs'
import { activeSuggestJob, enqueueSuggest, latestRound, parseRoundJob, runSuggest } from './service'

type Db = ReturnType<typeof createTestDb>['db']
const NOW = new Date('2026-09-18T10:00:00')

function topic(db: Db, id = 't1', over: Partial<typeof topics.$inferInsert> = {}) {
  db.insert(topics).values({ id, name: null, context: 'u lekarza z dzieckiem, grypa', suspendedAt: null, createdAt: NOW.getTime(), ...over }).run()
  return id
}

function suggestion(db: Db, answerPl: string, over: Partial<typeof suggestions.$inferInsert> = {}) {
  const id = over.id ?? `s-${answerPl}`
  db.insert(suggestions).values({
    id, topicId: 't1', round: 1, answerPl, glossRu: 'перевод', kind: 'slowo', status: 'proposed',
    captureId: null, createdAt: NOW.getTime(), ...over,
  }).run()
  return id
}

function card(db: Db, answerPl: string, over: { type?: 'ru_to_pl' | 'pl_to_pl' } = {}) {
  return createCard(db, {
    type: over.type ?? 'ru_to_pl', promptText: 'x', promptHint: null, answerPl, examplePl: null, exampleRu: null,
    grammarNote: null, wordKind: null, formsJson: null, status: 'ready',
  }, NOW).cardId
}

const jobRow = (db: Db, id: string) => db.select().from(generationJobs).where(eq(generationJobs.id, id)).get()!

function suggester(items: Suggestion['items'], topic_name = 'U lekarza z dzieckiem') {
  const suggest = vi.fn().mockResolvedValue({ topic_name, items } satisfies Suggestion)
  return { suggest } satisfies Suggester
}

const it_ = (answer_pl: string, kind: 'slowo' | 'fraza' = 'slowo') => ({ answer_pl, gloss_ru: `ru:${answer_pl}`, kind })

describe('enqueueSuggest', () => {
  it('queues round 1 for a new topic', () => {
    const { db } = createTestDb()
    topic(db)
    const id = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)!
    expect(jobRow(db, id)).toMatchObject({ kind: 'suggest', topicId: 't1', status: 'queued' })
    expect(parseRoundJob(jobRow(db, id).paramsJson)).toEqual({ round: 1, count: 10, mix: 'mieszane' })
  })

  it('queues the round after the highest one that exists', () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { round: 2 })
    expect(latestRound(db, 't1')).toBe(2)
    const id = enqueueSuggest(db, 't1', { count: 5, mix: 'frazy' }, NOW)!
    expect(parseRoundJob(jobRow(db, id).paramsJson).round).toBe(3)
  })

  it('refuses a second round while one is queued or running', () => {
    const { db } = createTestDb()
    topic(db)
    const first = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)!
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'running' }).where(eq(generationJobs.id, first)).run()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).where(eq(generationJobs.id, first)).run()
    expect(activeSuggestJob(db, 't1')).toBeUndefined()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).not.toBeNull()
  })
})

describe('runSuggest', () => {
  function queued(db: Db, count = 10, mix: 'mieszane' | 'slowa' | 'frazy' = 'mieszane') {
    return jobRow(db, enqueueSuggest(db, 't1', { count, mix }, NOW)!)
  }

  it('asks for count × 1.5 split by the mix, excluding the topic history', async () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { status: 'rejected' })
    suggestion(db, 'kaszel', { status: 'accepted' })
    const s = suggester([])
    await runSuggest({ db, suggester: s }, queued(db, 10, 'slowa'), NOW)
    expect(s.suggest).toHaveBeenCalledWith({
      context: 'u lekarza z dzieckiem, grypa', count: 15, words: 12, phrases: 3, exclude: ['katar', 'kaszel'],
    })
  })

  it('stores the round as proposed, dropping deck words, history and repeats, trimmed to count', async () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { status: 'rejected' })
    card(db, 'gorączka')
    const s = suggester([it_('Gorączka'), it_('katar'), it_('osłuchać'), it_('osłuchać'), it_('L4'), it_('recepta')])
    await runSuggest({ db, suggester: s }, queued(db, 2), NOW)
    const round2 = db.select().from(suggestions).where(eq(suggestions.round, 2)).all()
    expect(round2.map((r) => [r.answerPl, r.glossRu, r.status])).toEqual([
      ['osłuchać', 'ru:osłuchać', 'proposed'],
      ['L4', 'ru:L4', 'proposed'],
    ])
  })

  it('ignores deleted cards and forms-only cards when checking the deck', async () => {
    const { db } = createTestDb()
    topic(db)
    deleteCard(db, card(db, 'gorączka'), NOW)
    card(db, 'katar', { type: 'pl_to_pl' })
    await runSuggest({ db, suggester: suggester([it_('gorączka'), it_('katar')]) }, queued(db), NOW)
    expect(db.select().from(suggestions).all()).toHaveLength(2)
  })

  it('names an unnamed topic, and leaves a named one alone', async () => {
    const { db } = createTestDb()
    topic(db)
    await runSuggest({ db, suggester: suggester([it_('a')], 'U lekarza') }, queued(db), NOW)
    expect(db.select().from(topics).get()!.name).toBe('U lekarza')
    db.update(generationJobs).set({ status: 'done' }).run()
    await runSuggest({ db, suggester: suggester([it_('b')], 'Inna nazwa') }, queued(db), NOW)
    expect(db.select().from(topics).get()!.name).toBe('U lekarza')
  })

  // The process died after inserting the round but before the job was marked
  // done; the job runs again and must not produce a second copy.
  it('does nothing when its round already exists', async () => {
    const { db } = createTestDb()
    topic(db)
    const job = queued(db)
    suggestion(db, 'katar', { round: 1 })
    const s = suggester([it_('osłuchać')])
    await runSuggest({ db, suggester: s }, job, NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })

  it('throws the suggester’s error for the queue to classify', async () => {
    const { db } = createTestDb()
    topic(db)
    const boom = new Error('quota')
    await expect(
      runSuggest({ db, suggester: { suggest: vi.fn().mockRejectedValue(boom) } }, queued(db), NOW),
    ).rejects.toBe(boom)
  })

  it('refuses unreadable params rather than guessing', () => {
    expect(() => parseRoundJob('{"round":1}')).toThrow()
    expect(() => parseRoundJob(null)).toThrow()
  })

  it('does nothing for a job whose topic is gone', async () => {
    const { db } = createTestDb()
    const jobId = enqueueJob(db, { kind: 'suggest', topicId: null, paramsJson: '{"round":1,"count":10,"mix":"mieszane"}' }, NOW)
    const s = suggester([it_('a')])
    await runSuggest({ db, suggester: s }, jobRow(db, jobId), NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run to see them fail** — `npx vitest run lib/queue/jobs.test.ts lib/topics` — FAIL: `'suggest'` is not a job kind; `./service` does not exist.

- [ ] **Step 4: Queue changes.**

`lib/db/schema.ts` — `generationJobs.kind`'s enum becomes `['new', 'regenerate', 'rerecognized', 'suggest']`.

`lib/queue/jobs.ts`:

```ts
export type JobKind = 'new' | 'regenerate' | 'rerecognized' | 'suggest'
```

`enqueueJob`'s `input` gains `topicId?: string | null; paramsJson?: string | null`, and its `.values({...})` gains `topicId: input.topicId ?? null, paramsJson: input.paramsJson ?? null`.

In `runNextJob`, replace the `.orderBy(...)` and its comment with:

```ts
    // A `suggest` job first: it is a round someone is watching the screen
    // for (spec 2026-09-18-topic-generation §6.1). Then oldest first;
    // createdAt can tie when promoteApproved inserts several jobs in one
    // tick, and rowid (insertion order) breaks the tie deterministically.
    .orderBy(sql`CASE WHEN ${generationJobs.kind} = 'suggest' THEN 0 ELSE 1 END`, asc(generationJobs.createdAt), sql`rowid`)
```

Update `runNextJob`'s doc comment first line to "Runs at most one job: a due `suggest` job if there is one, else the oldest due job."

- [ ] **Step 5: The service.** `lib/topics/service.ts`:

```ts
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client'
import { cards, generationJobs, suggestions, topics } from '../db/schema'
import { answerKey } from '../cards/answer-key'
import type { Suggester } from '../generate'
import { enqueueJob, type JobRow } from '../queue/jobs'
import { MIXES, mixTarget, pickRound, requestSize, type RoundParams } from './rounds'

/**
 * Topics and their rounds (spec 2026-09-18-topic-generation). Everything here
 * that touches the database; the pure rules are in ./rounds.
 */

export type TopicRow = typeof topics.$inferSelect
export type SuggestionRow = typeof suggestions.$inferSelect

const RoundJob = z.object({
  round: z.number().int().positive(),
  count: z.number().int().positive(),
  mix: z.enum(MIXES),
})

export function parseRoundJob(paramsJson: string | null): z.infer<typeof RoundJob> {
  return RoundJob.parse(JSON.parse(paramsJson ?? 'null'))
}

/** The topic's `suggest` job that is waiting or running, if any: at most one at a time (§6.1). */
export function activeSuggestJob(db: Db, topicId: string): JobRow | undefined {
  return db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, 'suggest'),
        eq(generationJobs.topicId, topicId),
        inArray(generationJobs.status, ['queued', 'running']),
      ),
    )
    .get()
}

/** The highest round that has items; 0 before the first one arrives. */
export function latestRound(db: Db, topicId: string): number {
  const row = db.select({ n: max(suggestions.round) }).from(suggestions).where(eq(suggestions.topicId, topicId)).get()
  return row?.n ?? 0
}

/**
 * Queues the next round, numbered after the highest that exists. A failed
 * round left no items, so retrying it gets the same number. Returns null,
 * queueing nothing, while the topic already has a round in flight.
 */
export function enqueueSuggest(db: Db, topicId: string, params: RoundParams, now: Date): string | null {
  if (activeSuggestJob(db, topicId)) return null
  const round = latestRound(db, topicId) + 1
  return enqueueJob(db, { kind: 'suggest', topicId, paramsJson: JSON.stringify({ round, ...params }) }, now)
}

/** answer keys of live ru_to_pl cards: a round never offers a word already in the deck. */
function deckKeys(db: Db): string[] {
  return db
    .select({ key: cards.answerKey })
    .from(cards)
    .where(and(eq(cards.type, 'ru_to_pl'), isNull(cards.deletedAt)))
    .all()
    .map((r) => r.key)
}

function roundExists(db: Db, topicId: string, round: number): boolean {
  return !!db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(and(eq(suggestions.topicId, topicId), eq(suggestions.round, round)))
    .get()
}

/**
 * Job `suggest`: asks for a round and stores what survives dedup as
 * `proposed` (§5). The deck is filtered here rather than sent in the prompt:
 * it grows without bound, the topic's history does not. A failure is thrown
 * for the queue to classify; there is nothing to fall back to.
 */
export async function runSuggest(deps: { db: Db; suggester: Suggester }, job: JobRow, now: Date): Promise<void> {
  const { db } = deps
  const params = parseRoundJob(job.paramsJson)
  const topic = job.topicId ? db.select().from(topics).where(eq(topics.id, job.topicId)).get() : undefined
  if (!topic) return
  // Already stored by a run that died before the job was marked done.
  if (roundExists(db, topic.id, params.round)) return

  const history = db
    .select({ answerPl: suggestions.answerPl })
    .from(suggestions)
    .where(eq(suggestions.topicId, topic.id))
    .orderBy(suggestions.createdAt, sql`rowid`)
    .all()
    .map((r) => r.answerPl)
  const n = requestSize(params.count)
  const result = await deps.suggester.suggest({ context: topic.context, count: n, ...mixTarget(n, params.mix), exclude: history })

  const taken = new Set([...history.map(answerKey), ...deckKeys(db)])
  const picked = pickRound(result.items, taken, params.count)
  const name = result.topic_name.trim()
  db.transaction((tx) => {
    if (roundExists(tx as unknown as Db, topic.id, params.round)) return
    if (name) tx.update(topics).set({ name }).where(and(eq(topics.id, topic.id), isNull(topics.name))).run()
    for (const item of picked) {
      tx.insert(suggestions)
        .values({
          id: randomUUID(),
          topicId: topic.id,
          round: params.round,
          answerPl: item.answer_pl,
          glossRu: item.gloss_ru,
          kind: item.kind,
          status: 'proposed',
          captureId: null,
          createdAt: now.getTime(),
        })
        .run()
    }
  })
}
```

- [ ] **Step 6: Wire the handler.** `lib/capture/pipeline.ts`:

```ts
import type { Generator, Suggester } from '../generate'   // extend the existing import from '../generate'
import { runSuggest } from '../topics/service'
```

Change `jobHandlers`:

```ts
/** The four job kinds, wired to their bodies. */
export function jobHandlers(deps: CaptureDeps & { suggester: Suggester }): JobHandlers {
  return {
    // ...new, rerecognized, regenerate unchanged...
    // No give-up action: the job's `failed` status and last_error are the
    // record, and the topic page offers `spróbuj ponownie` (§6.1).
    suggest: {
      run: (job, now) => runSuggest({ db: deps.db, suggester: deps.suggester }, job, now),
      giveUp: () => {},
    },
  }
}
```

In `lib/capture/pipeline.test.ts`, the two `jobHandlers(d)` calls become `jobHandlers({ ...d, suggester: { suggest: vi.fn() } })`.

`lib/queue/worker.ts`: `Providers` becomes `{ transcriber: Transcriber; generator: Generator; suggester: Suggester }` (import `Suggester` type); in `startWorker` import `getSuggester` alongside `getGenerator` and build `{ transcriber: getTranscriber(), generator: getGenerator(), suggester: getSuggester() }`.

- [ ] **Step 7: Run the tests** — `npx vitest run lib/queue lib/topics lib/capture` — PASS.
- [ ] **Step 8: Gates, then commit**

```bash
git add lib/db/schema.ts lib/queue/jobs.ts lib/queue/jobs.test.ts lib/queue/worker.ts lib/topics/service.ts lib/topics/service.test.ts lib/capture/pipeline.ts lib/capture/pipeline.test.ts
git commit -m "feat: suggest jobs produce a topic's rounds, ahead of other jobs"
```

---

### Task 5: Accepting a round; topic cards

**Files:**
- Modify: `lib/topics/service.ts`, `lib/topics/service.test.ts`, `lib/cards/service.ts`, `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 4's service.
- Produces:
  - `CreateCardInput.topicId?: string | null` (a duplicate keeps its own topic)
  - `acceptRound(db, topicId: string, round: number, rejected: readonly string[], next: RoundParams | null, now: Date): { accepted: number; nextJobId: string | null } | null` — `null` for an unknown topic.
  - `generateNewCard` passes a `Meaning` for a topic capture and sets the card's `topicId`; `giveUpNewCard` sets `topicId` too.

- [ ] **Step 1: Failing tests for accepting** — append to `lib/topics/service.test.ts` (extend imports with `acceptRound`, and `captures` from the schema):

```ts
describe('acceptRound', () => {
  function round1(db: Db) {
    topic(db)
    return ['gorączka', 'katar', 'osłuchać'].map((w) => suggestion(db, w))
  }

  it('turns every item not struck out into a queued, audio-less capture with a new job', () => {
    const { db } = createTestDb()
    const [a, b, c] = round1(db)
    expect(acceptRound(db, 't1', 1, [b], null, NOW)).toEqual({ accepted: 2, nextJobId: null })

    const caps = db.select().from(captures).all()
    expect(caps.map((x) => [x.transcript, x.status, x.audioMediaId, x.topicId, x.glossRu]).sort()).toEqual([
      ['gorączka', 'queued', null, 't1', 'перевод'],
      ['osłuchać', 'queued', null, 't1', 'перевод'],
    ])
    const jobs = db.select().from(generationJobs).all()
    expect(jobs.map((j) => j.kind)).toEqual(['new', 'new'])
    expect(new Set(jobs.map((j) => j.captureId))).toEqual(new Set(caps.map((x) => x.id)))

    const byId = new Map(db.select().from(suggestions).all().map((s) => [s.id, s]))
    expect(byId.get(a)!.status).toBe('accepted')
    expect(byId.get(a)!.captureId).not.toBeNull()
    expect(byId.get(b)!).toMatchObject({ status: 'rejected', captureId: null })
    expect(byId.get(c)!.status).toBe('accepted')
  })

  it('changes nothing when repeated', () => {
    const { db } = createTestDb()
    round1(db)
    acceptRound(db, 't1', 1, [], null, NOW)
    expect(acceptRound(db, 't1', 1, [], null, NOW)).toEqual({ accepted: 0, nextJobId: null })
    expect(db.select().from(captures).all()).toHaveLength(3)
  })

  it('touches only the given round', () => {
    const { db } = createTestDb()
    round1(db)
    suggestion(db, 'L4', { round: 2 })
    acceptRound(db, 't1', 2, [], null, NOW)
    expect(db.select().from(suggestions).where(eq(suggestions.round, 1)).all().every((s) => s.status === 'proposed')).toBe(true)
  })

  it('queues exactly one next round when asked', () => {
    const { db } = createTestDb()
    round1(db)
    const { nextJobId } = acceptRound(db, 't1', 1, [], { count: 5, mix: 'frazy' }, NOW)!
    expect(parseRoundJob(jobRow(db, nextJobId!).paramsJson)).toEqual({ round: 2, count: 5, mix: 'frazy' })
    expect(acceptRound(db, 't1', 1, [], { count: 5, mix: 'frazy' }, NOW)!.nextJobId).toBeNull()
    expect(db.select().from(generationJobs).where(eq(generationJobs.kind, 'suggest')).all()).toHaveLength(1)
  })

  it('answers null for an unknown topic', () => {
    const { db } = createTestDb()
    expect(acceptRound(db, 'nope', 1, [], null, NOW)).toBeNull()
  })
})
```

- [ ] **Step 2: Failing tests for topic cards** — append to `lib/capture/pipeline.test.ts` (import `topics`, `suggestions` from the schema and `acceptRound` from `'../topics/service'`):

```ts
describe('a topic item becoming a card', () => {
  function accepted(d: ReturnType<typeof deps>) {
    d.db.insert(topics).values({ id: 't1', name: null, context: 'u lekarza z dzieckiem', suspendedAt: null, createdAt: NOW.getTime() }).run()
    d.db.insert(suggestions).values({
      id: 's1', topicId: 't1', round: 1, answerPl: 'złośliwy', glossRu: 'злобный', kind: 'slowo',
      status: 'proposed', captureId: null, createdAt: NOW.getTime(),
    }).run()
    acceptRound(d.db, 't1', 1, [], null, NOW)
    return d.db.select().from(captures).get()!.id
  }

  it('sends the gloss and the situation, and files the card under the topic', async () => {
    const d = deps()
    const id = accepted(d)
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('złośliwy', { glossRu: 'злобный', context: 'u lekarza z dzieckiem' })
    expect(d.db.select().from(cards).get()!.topicId).toBe('t1')
    expect(row(d, id).status).toBe('generated')
  })

  it('keeps the word under the topic when generation gives up', () => {
    const d = deps()
    const id = accepted(d)
    giveUpNewCard(d.db, id, 'unusable', NOW)
    expect(d.db.select().from(cards).get()).toMatchObject({ status: 'needs_input', topicId: 't1' })
  })

  it('leaves an existing card’s topic alone when the item is a duplicate', async () => {
    const d = deps()
    const existing = createCard(d.db, input(), NOW).cardId
    const id = accepted(d)
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(cards).get()!).toMatchObject({ id: existing, topicId: null })
  })

  it('calls a plain dictation with the transcript alone, as before', async () => {
    const d = deps()
    const id = await recognized(d, 'zloslivy')
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('zloslivy')
  })
})
```

(`recognized`, `row`, `input` and `deps` are the file's existing helpers.)

- [ ] **Step 3: Run to see them fail** — `npx vitest run lib/topics lib/capture` — FAIL: `acceptRound` missing; no meaning passed; `topicId` null.

- [ ] **Step 4: `createCard` takes a topic.** `lib/cards/service.ts`: add to `CreateCardInput`

```ts
  /** The topic a generated item belongs to (spec 2026-09-18-topic-generation §3.4). A duplicate keeps its own. */
  topicId?: string | null
```

and in `createCard`'s `.values({...})` add `topicId: input.topicId ?? null,`.

- [ ] **Step 5: `acceptRound`.** Append to `lib/topics/service.ts` (add `captures` to the schema import):

```ts
/**
 * Accepts a round in one transaction (§6.3): every `proposed` item of it is
 * rejected if listed, otherwise accepted — becoming an audio-less capture
 * with an ordinary `new` job, so card generation, dedup and the pending list
 * are the dictation ones. Only `proposed` items change, so a repeated request
 * is harmless. `next` also queues the following round, unless one is already
 * in flight.
 */
export function acceptRound(
  db: Db,
  topicId: string,
  round: number,
  rejected: readonly string[],
  next: RoundParams | null,
  now: Date,
): { accepted: number; nextJobId: string | null } | null {
  return db.transaction((tx) => {
    const t = tx as unknown as Db
    if (!t.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get()) return null
    const reject = new Set(rejected)
    const proposed = t
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.topicId, topicId), eq(suggestions.round, round), eq(suggestions.status, 'proposed')))
      .orderBy(suggestions.createdAt, sql`rowid`)
      .all()
    let accepted = 0
    for (const s of proposed) {
      if (reject.has(s.id)) {
        t.update(suggestions).set({ status: 'rejected' }).where(eq(suggestions.id, s.id)).run()
        continue
      }
      const captureId = randomUUID()
      t.insert(captures)
        .values({
          id: captureId,
          audioMediaId: null,
          transcript: s.answerPl,
          status: 'queued',
          error: null,
          generationJson: null,
          cardId: null,
          createdAt: now.getTime(),
          transcribedAt: null,
          duplicateOf: null,
          topicId,
          glossRu: s.glossRu,
        })
        .run()
      enqueueJob(t, { kind: 'new', captureId }, now)
      t.update(suggestions).set({ status: 'accepted', captureId }).where(eq(suggestions.id, s.id)).run()
      accepted++
    }
    return { accepted, nextJobId: next ? enqueueSuggest(t, topicId, next, now) : null }
  })
}
```

- [ ] **Step 6: The `new` job uses the topic.** In `lib/capture/pipeline.ts`:

Import `topics` from the schema and the `Meaning` type from `'../generate'`. Add above `generateNewCard`:

```ts
/** A topic item's intended sense and situation; undefined for a dictation. */
function meaningOf(db: Db, capture: { topicId: string | null; glossRu: string | null }): Meaning | undefined {
  if (!capture.topicId || !capture.glossRu) return undefined
  const topic = db.select({ context: topics.context }).from(topics).where(eq(topics.id, capture.topicId)).get()
  return topic ? { glossRu: capture.glossRu, context: topic.context } : undefined
}
```

In `generateNewCard`, replace `const generated = await generator.fromDictation(transcript)` with:

```ts
  const meaning = meaningOf(db, capture)
  // Called with the transcript alone for a dictation, exactly as before.
  const generated = meaning ? await generator.fromDictation(transcript, meaning) : await generator.fromDictation(transcript)
```

and add `topicId: capture.topicId,` to its `createCard` input. In `giveUpNewCard`, add `topicId: capture.topicId,` to its `createCard` input. Update `generateNewCard`'s doc comment: "Job `new`: an approved recording, or an accepted topic item, becomes a card. …"

- [ ] **Step 7: Run the tests** — `npx vitest run lib` — PASS.
- [ ] **Step 8: Gates, then commit**

```bash
git add lib/topics/service.ts lib/topics/service.test.ts lib/cards/service.ts lib/capture/pipeline.ts lib/capture/pipeline.test.ts
git commit -m "feat: accepting a round queues its items as cards under the topic"
```

---

### Task 6: Create, list, view, update, retry

**Files:**
- Modify: `lib/topics/service.ts`, `lib/topics/service.test.ts`

**Interfaces:**
- Produces:
  - `createTopic(db, input: { context: string } & RoundParams, now): string` (the topic id)
  - `type TopicListRow = TopicRow & { cardCount: number; pendingCount: number }`; `listTopics(db): TopicListRow[]` (newest first)
  - `type RoundState = 'searching' | 'failed' | 'ready' | 'idle'`
  - `type TopicView = { topic: TopicRow; state: RoundState; error: string | null; round: number; items: { id: string; answerPl: string; glossRu: string; kind: SuggestionKind }[]; cards: CardRow[]; pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[] }`; `topicView(db, id): TopicView | null`
  - `updateTopic(db, id, patch: { name?: string; context?: string; suspendedAt?: number | null }): TopicRow | null`
  - `retrySuggest(db, topicId, now): string | null` — re-queues the latest failed round's params; null if the latest `suggest` job is not `failed` or one is in flight.

- [ ] **Step 1: Failing tests** — append to `lib/topics/service.test.ts` (extend imports: `createTopic, listTopics, topicView, updateTopic, retrySuggest, acceptRound`, and `captures` from the schema):

```ts
describe('createTopic', () => {
  it('stores the trimmed context and queues round 1', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: '  u mechanika  ', count: 5, mix: 'slowa' }, NOW)
    expect(db.select().from(topics).get()).toMatchObject({ id, name: null, context: 'u mechanika', suspendedAt: null })
    expect(parseRoundJob(activeSuggestJob(db, id)!.paramsJson)).toEqual({ round: 1, count: 5, mix: 'slowa' })
  })
})

describe('topicView', () => {
  it('is searching while a round is in flight', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane' }, NOW)
    expect(topicView(db, id)).toMatchObject({ state: 'searching', round: 0, items: [] })
  })

  it('is failed, with the error, when the latest round gave up', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane' }, NOW)
    db.update(generationJobs).set({ status: 'failed', lastError: 'unusable payload' }).run()
    expect(topicView(db, id)).toMatchObject({ state: 'failed', error: 'unusable payload' })
  })

  it('is ready with the latest round’s proposed items, then idle once they are decided', () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { round: 1, status: 'accepted' })
    suggestion(db, 'gorączka', { round: 2 })
    expect(topicView(db, 't1')).toMatchObject({
      state: 'ready', round: 2, items: [{ id: 's-gorączka', answerPl: 'gorączka', glossRu: 'перевод', kind: 'slowo' }],
    })
    acceptRound(db, 't1', 2, [], null, NOW)
    expect(topicView(db, 't1')).toMatchObject({ state: 'idle', round: 2, items: [] })
  })

  it('lists the topic’s live cards and its pending items, and nothing else', () => {
    const { db } = createTestDb()
    topic(db)
    topic(db, 't2')
    const mine = card(db, 'katar')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, mine)).run()
    const gone = card(db, 'kaszel')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, gone)).run()
    deleteCard(db, gone, NOW)
    card(db, 'kot')
    suggestion(db, 'gorączka')
    acceptRound(db, 't1', 1, [], null, NOW)
    const v = topicView(db, 't1')!
    expect(v.cards.map((c) => c.answerPl)).toEqual(['katar'])
    expect(v.pending).toEqual([{ id: expect.any(String), transcript: 'gorączka', status: 'queued' }])
  })

  it('is null for an unknown topic', () => {
    const { db } = createTestDb()
    expect(topicView(db, 'nope')).toBeNull()
  })
})

describe('listTopics', () => {
  it('counts live cards and pending items per topic, newest topic first', () => {
    const { db } = createTestDb()
    topic(db, 't1', { createdAt: 1 })
    topic(db, 't2', { createdAt: 2 })
    const k = card(db, 'katar')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, k)).run()
    suggestion(db, 'gorączka')
    acceptRound(db, 't1', 1, [], null, NOW)
    expect(listTopics(db).map((t) => [t.id, t.cardCount, t.pendingCount])).toEqual([
      ['t2', 0, 0],
      ['t1', 1, 1],
    ])
  })
})

describe('updateTopic', () => {
  it('renames, edits the context and switches the topic off and on', () => {
    const { db } = createTestDb()
    topic(db)
    expect(updateTopic(db, 't1', { name: 'U lekarza', context: 'nowy kontekst', suspendedAt: 5 })).toMatchObject({
      name: 'U lekarza', context: 'nowy kontekst', suspendedAt: 5,
    })
    expect(updateTopic(db, 't1', { suspendedAt: null })!.suspendedAt).toBeNull()
    expect(updateTopic(db, 'nope', { name: 'x' })).toBeNull()
  })
})

describe('retrySuggest', () => {
  it('re-queues a failed round with the same params, and only then', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 5, mix: 'frazy' }, NOW)
    expect(retrySuggest(db, id, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const again = retrySuggest(db, id, NOW)!
    expect(parseRoundJob(jobRow(db, again).paramsJson)).toEqual({ round: 1, count: 5, mix: 'frazy' })
    expect(retrySuggest(db, id, NOW)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run lib/topics` — FAIL: missing exports.

- [ ] **Step 3: Implement** — append to `lib/topics/service.ts` (add `desc`, `isNotNull`, `count` to the drizzle import, and `import type { CardRow } from '../cards/service'`, `import type { SuggestionKind } from './rounds'`):

```ts
export function createTopic(db: Db, input: { context: string } & RoundParams, now: Date): string {
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(topics).values({ id, name: null, context: input.context.trim(), suspendedAt: null, createdAt: now.getTime() }).run()
    enqueueSuggest(tx as unknown as Db, id, { count: input.count, mix: input.mix }, now)
  })
  return id
}

const PENDING = ['queued', 'generating'] as const

export type TopicListRow = TopicRow & { cardCount: number; pendingCount: number }

export function listTopics(db: Db): TopicListRow[] {
  const cardCounts = new Map(
    db
      .select({ topicId: cards.topicId, n: count() })
      .from(cards)
      .where(and(isNotNull(cards.topicId), isNull(cards.deletedAt)))
      .groupBy(cards.topicId)
      .all()
      .map((r) => [r.topicId!, r.n]),
  )
  const pendingCounts = new Map(
    db
      .select({ topicId: captures.topicId, n: count() })
      .from(captures)
      .where(and(isNotNull(captures.topicId), inArray(captures.status, PENDING)))
      .groupBy(captures.topicId)
      .all()
      .map((r) => [r.topicId!, r.n]),
  )
  return db
    .select()
    .from(topics)
    .orderBy(desc(topics.createdAt))
    .all()
    .map((t) => ({ ...t, cardCount: cardCounts.get(t.id) ?? 0, pendingCount: pendingCounts.get(t.id) ?? 0 }))
}

function latestSuggestJob(db: Db, topicId: string): JobRow | undefined {
  return db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, 'suggest'), eq(generationJobs.topicId, topicId)))
    .orderBy(desc(generationJobs.createdAt), desc(sql`rowid`))
    .get()
}

export type RoundState = 'searching' | 'failed' | 'ready' | 'idle'

export type TopicView = {
  topic: TopicRow
  state: RoundState
  error: string | null
  /** The highest round with items; 0 before the first arrives. */
  round: number
  /** That round's still-undecided items. */
  items: { id: string; answerPl: string; glossRu: string; kind: SuggestionKind }[]
  cards: CardRow[]
  pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
}

/** Everything the topic page shows; its round state is derived, never stored (§4.4). */
export function topicView(db: Db, id: string): TopicView | null {
  const topic = db.select().from(topics).where(eq(topics.id, id)).get()
  if (!topic) return null
  const round = latestRound(db, id)
  const items = db
    .select({ id: suggestions.id, answerPl: suggestions.answerPl, glossRu: suggestions.glossRu, kind: suggestions.kind })
    .from(suggestions)
    .where(and(eq(suggestions.topicId, id), eq(suggestions.round, round), eq(suggestions.status, 'proposed')))
    .orderBy(suggestions.createdAt, sql`rowid`)
    .all()
  const latest = latestSuggestJob(db, id)
  const state: RoundState = activeSuggestJob(db, id)
    ? 'searching'
    : latest?.status === 'failed'
      ? 'failed'
      : items.length > 0
        ? 'ready'
        : 'idle'
  return {
    topic,
    state,
    error: state === 'failed' ? latest!.lastError : null,
    round,
    items,
    cards: db
      .select()
      .from(cards)
      .where(and(eq(cards.topicId, id), isNull(cards.deletedAt)))
      .orderBy(desc(cards.createdAt))
      .all(),
    pending: db
      .select({ id: captures.id, transcript: captures.transcript, status: captures.status })
      .from(captures)
      .where(and(eq(captures.topicId, id), inArray(captures.status, PENDING)))
      .orderBy(desc(captures.createdAt))
      .all() as TopicView['pending'],
  }
}

export function updateTopic(
  db: Db,
  id: string,
  patch: { name?: string; context?: string; suspendedAt?: number | null },
): TopicRow | null {
  if (!db.select({ id: topics.id }).from(topics).where(eq(topics.id, id)).get()) return null
  const set: Partial<TopicRow> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.context !== undefined) set.context = patch.context.trim()
  if (patch.suspendedAt !== undefined) set.suspendedAt = patch.suspendedAt
  if (Object.keys(set).length > 0) db.update(topics).set(set).where(eq(topics.id, id)).run()
  return db.select().from(topics).where(eq(topics.id, id)).get()!
}

/** `spróbuj ponownie`: the failed round again, with its own count and mix. */
export function retrySuggest(db: Db, topicId: string, now: Date): string | null {
  const latest = latestSuggestJob(db, topicId)
  if (latest?.status !== 'failed') return null
  const { count: n, mix } = parseRoundJob(latest.paramsJson)
  return enqueueSuggest(db, topicId, { count: n, mix }, now)
}
```

Note the destructuring rename `count: n` in `retrySuggest`: the drizzle `count` import would otherwise be shadowed.

- [ ] **Step 4: Run the tests** — `npx vitest run lib/topics` — PASS.
- [ ] **Step 5: Gates, then commit**

```bash
git add lib/topics/service.ts lib/topics/service.test.ts
git commit -m "feat: create, list, view, update and retry topics"
```

---

### Task 7: A suspended topic leaves review

**Files:**
- Modify: `lib/review/queue.ts`, `lib/review/queue.test.ts`

**Interfaces:**
- Consumes: `topics` (Task 2).
- Produces: `REVIEWABLE` also requires the card's topic to be null or not suspended. Every user of it (`buildQueue`, `app/api/review/queue/route.ts`) follows.

- [ ] **Step 1: The index guard, before any change.** Add to `lib/review/queue.test.ts` (import `and`, `asc`, `lte`, `sql` from drizzle-orm and `REVIEWABLE` from `./queue`):

```ts
describe('the due query', () => {
  it('uses the cards_due index', () => {
    const { db, sqlite } = createTestDb()
    const q = db
      .select({ id: cards.id })
      .from(cards)
      .where(and(REVIEWABLE, sql`${cards.state} != 0`, lte(cards.due, 0)))
      .orderBy(asc(cards.due))
      .toSQL()
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/cards_due/)
  })
})
```

Run `npx vitest run lib/review/queue.test.ts -t "cards_due"` **before** touching `REVIEWABLE`.
- If it **passes**: keep it — it now guards the index against Step 4.
- If it **fails**: today's query already does not use `cards_due` (the `status` comparison is a bound parameter, which a partial index cannot be proven against). Delete the test, and say so in your report: there is no index use for this change to regress. Do not try to fix the index here.

- [ ] **Step 2: Failing behaviour tests** — add (import `topics` from the schema):

```ts
describe('topics in review', () => {
  function withTopic(db: ReturnType<typeof createTestDb>['db'], suspendedAt: number | null) {
    db.insert(topics).values({ id: 't1', name: 'x', context: 'x', suspendedAt, createdAt: 1 }).run()
  }

  it('leaves out a card whose topic is switched off', async () => {
    const { db } = createTestDb()
    withTopic(db, NOW.getTime())
    insertCard(db, { id: 'a', topicId: 't1' })
    insertCard(db, { id: 'b', answerPl: 'kot', answerKey: 'kot' })
    expect((await buildQueue(db, NOW)).map((c) => c.id)).toEqual(['b'])
  })

  it('serves it again once the topic is switched back on', async () => {
    const { db } = createTestDb()
    withTopic(db, null)
    insertCard(db, { id: 'a', topicId: 't1' })
    expect((await buildQueue(db, NOW)).map((c) => c.id)).toEqual(['a'])
  })

  // The topic switch never writes cards.suspended_at, so a card suspended on
  // its own stays suspended whatever its topic does (spec §3.5).
  it('keeps an individually suspended card out under a topic that is on', async () => {
    const { db } = createTestDb()
    withTopic(db, null)
    insertCard(db, { id: 'a', topicId: 't1', suspendedAt: 1 })
    expect(await buildQueue(db, NOW)).toEqual([])
  })
})
```

- [ ] **Step 3: Run to see them fail** — the first test FAILS (the card in the switched-off topic is served).

- [ ] **Step 4: Implement.** In `lib/review/queue.ts`, import `topics` from the schema and replace `REVIEWABLE` and its comment's last sentence:

```ts
// ...existing comment through "no index migration needed."...
// A card is also out of review while its topic is switched off (spec
// 2026-09-18-topic-generation §3.5). That is a separate condition from the
// card's own suspended_at, so switching a topic back on never revives a card
// suspended by hand.
export const REVIEWABLE = and(
  isNull(cards.suspendedAt),
  isNull(cards.deletedAt),
  eq(cards.status, 'ready'),
  sql`(${cards.topicId} IS NULL OR NOT EXISTS (SELECT 1 FROM ${topics} WHERE ${topics.id} = ${cards.topicId} AND ${topics.suspendedAt} IS NOT NULL))`,
)
```

- [ ] **Step 5: Run the tests** — `npx vitest run lib/review app/api/review` — PASS (including the index guard if you kept it).
- [ ] **Step 6: Gates, then commit**

```bash
git add lib/review/queue.ts lib/review/queue.test.ts
git commit -m "feat: a switched-off topic takes its cards out of review"
```

---

### Task 8: Topic endpoints

**Files:**
- Create: `lib/topics/body.ts`, `app/api/topics/route.ts`, `app/api/topics/transcribe/route.ts`, `app/api/topics/[id]/route.ts`, `app/api/topics/[id]/rounds/[round]/route.ts`, `app/api/topics/[id]/retry/route.ts`, `app/api/topics/route.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces (all JSON):
  - `GET /api/topics` → `{ topics: TopicListRow[] }`
  - `POST /api/topics` `{ context, count, mix }` → 201 `{ topicId }`; 400 on a bad body
  - `POST /api/topics/transcribe` multipart `audio`, `lang` (`pl`|`ru`, default `ru`) → `{ transcript }`, or 502 `{ error }`
  - `GET /api/topics/:id` → `TopicView`; 404
  - `PATCH /api/topics/:id` `{ name?, context?, suspendedAt? }` → `{ topic }`; 400; 404
  - `POST /api/topics/:id/rounds/:round` `{ rejected: string[], next?: { count, mix } }` → `{ accepted, nextJobId }`; 400; 404
  - `POST /api/topics/:id/retry` → `{ jobId }` (null when there is nothing to retry)

- [ ] **Step 1: Failing tests** — `app/api/topics/route.test.ts`, one file for all topic routes, following `app/api/captures/[id]/jezyk/route.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-topics-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const transcribeMock = vi.fn()
vi.mock('@/lib/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcribe')>()
  return { ...actual, getTranscriber: () => ({ transcribe: transcribeMock }) }
})

const topicsRoute = await import('./route')
const transcribeRoute = await import('./transcribe/route')
const topicRoute = await import('./[id]/route')
const roundRoute = await import('./[id]/rounds/[round]/route')
const retryRoute = await import('./[id]/retry/route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs, suggestions, topics } = await import('@/lib/db/schema')
const { TranscriptionError } = await import('@/lib/transcribe')

const json = (body: unknown, method = 'POST') =>
  new Request('http://test/api/topics', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

beforeEach(() => {
  db.delete(suggestions).run()
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(topics).run()
  transcribeMock.mockReset()
})

async function created() {
  const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'mieszane' }))
  return ((await res.json()) as { topicId: string }).topicId
}

describe('POST /api/topics', () => {
  it('creates the topic and queues its first round', async () => {
    const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'slowa' }))
    expect(res.status).toBe(201)
    const { topicId } = (await res.json()) as { topicId: string }
    expect(db.select().from(generationJobs).get()).toMatchObject({ kind: 'suggest', topicId })
  })

  it.each([
    { context: '', count: 10, mix: 'mieszane' },
    { context: 'x', count: 7, mix: 'mieszane' },
    { context: 'x', count: 10, mix: 'wszystko' },
  ])('refuses %o', async (body) => {
    expect((await topicsRoute.POST(json(body))).status).toBe(400)
  })
})

describe('GET /api/topics', () => {
  it('lists topics with their counts', async () => {
    const id = await created()
    const body = (await (await topicsRoute.GET()).json()) as { topics: { id: string; cardCount: number }[] }
    expect(body.topics).toEqual([expect.objectContaining({ id, cardCount: 0, pendingCount: 0 })])
  })
})

describe('POST /api/topics/transcribe', () => {
  function form(lang?: string) {
    const f = new FormData()
    f.set('audio', new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }))
    if (lang) f.set('lang', lang)
    return new Request('http://test/api/topics/transcribe', { method: 'POST', body: f })
  }

  it('recognises in Russian by default, and stores nothing', async () => {
    transcribeMock.mockResolvedValue('иду к врачу с ребёнком')
    const res = await transcribeRoute.POST(form())
    expect(await res.json()).toEqual({ transcript: 'иду к врачу с ребёнком' })
    expect(transcribeMock.mock.calls[0][0].lang).toBe('ru')
    expect(db.select().from(captures).all()).toEqual([])
  })

  it('recognises in Polish on request', async () => {
    transcribeMock.mockResolvedValue('u lekarza')
    await transcribeRoute.POST(form('pl'))
    expect(transcribeMock.mock.calls[0][0].lang).toBe('pl')
  })

  it('reports a recognition failure', async () => {
    transcribeMock.mockRejectedValue(new TranscriptionError('no speech'))
    const res = await transcribeRoute.POST(form())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'no speech' })
  })
})

describe('GET and PATCH /api/topics/:id', () => {
  it('returns the view', async () => {
    const id = await created()
    const res = await topicRoute.GET(new Request('http://test'), params({ id }))
    expect(await res.json()).toMatchObject({ topic: { id }, state: 'searching' })
  })

  it('is 404 for an unknown topic', async () => {
    expect((await topicRoute.GET(new Request('http://test'), params({ id: 'nope' }))).status).toBe(404)
    expect((await topicRoute.PATCH(json({ name: 'x' }, 'PATCH'), params({ id: 'nope' }))).status).toBe(404)
  })

  it('switches a topic off', async () => {
    const id = await created()
    const res = await topicRoute.PATCH(json({ suspendedAt: 123 }, 'PATCH'), params({ id }))
    expect(await res.json()).toMatchObject({ topic: { id, suspendedAt: 123 } })
  })

  it('refuses an empty name', async () => {
    const id = await created()
    expect((await topicRoute.PATCH(json({ name: ' ' }, 'PATCH'), params({ id }))).status).toBe(400)
  })
})

describe('POST /api/topics/:id/rounds/:round', () => {
  it('accepts the round and queues the next', async () => {
    const id = await created()
    db.update(generationJobs).set({ status: 'done' }).run()
    db.insert(suggestions).values({
      id: 's1', topicId: id, round: 1, answerPl: 'sprzęgło', glossRu: 'сцепление', kind: 'slowo',
      status: 'proposed', captureId: null, createdAt: 1,
    }).run()
    const res = await roundRoute.POST(json({ rejected: [], next: { count: 5, mix: 'frazy' } }), params({ id, round: '1' }))
    expect(await res.json()).toEqual({ accepted: 1, nextJobId: expect.any(String) })
  })

  it('refuses a bad round number or body, and an unknown topic', async () => {
    const id = await created()
    expect((await roundRoute.POST(json({ rejected: [] }), params({ id, round: 'x' }))).status).toBe(400)
    expect((await roundRoute.POST(json({}), params({ id, round: '1' }))).status).toBe(400)
    expect((await roundRoute.POST(json({ rejected: [] }), params({ id: 'nope', round: '1' }))).status).toBe(404)
  })
})

describe('POST /api/topics/:id/retry', () => {
  it('re-queues a failed round', async () => {
    const id = await created()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const res = await retryRoute.POST(new Request('http://test', { method: 'POST' }), params({ id }))
    expect(await res.json()).toEqual({ jobId: expect.any(String) })
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run app/api/topics` — FAIL: the route modules do not exist.

- [ ] **Step 3: Implement.**

`lib/topics/body.ts` — shared by two routes. It cannot live in a `route.ts`: Next.js refuses any export from a route file other than its handlers and config.

```ts
import { z } from 'zod'
import { COUNTS, MIXES } from './rounds'

/** A round's settings as a request body: only the offered counts and mixes. */
export const RoundBody = z.object({
  count: z.number().int().refine((n) => (COUNTS as readonly number[]).includes(n)),
  mix: z.enum(MIXES),
})
```

`app/api/topics/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { createTopic, listTopics } from '@/lib/topics/service'
import { RoundBody } from '@/lib/topics/body'

const Body = RoundBody.extend({ context: z.string().trim().min(1) })

export async function GET() {
  return NextResponse.json({ topics: listTopics(db) })
}

/** Creates a topic and queues its first round; the round arrives through the queue (spec §6). */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad topic' }, { status: 400 })
  return NextResponse.json({ topicId: createTopic(db, body.data, new Date()) }, { status: 201 })
}
```

`app/api/topics/transcribe/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getTranscriber, type DictationLang } from '@/lib/transcribe'

/**
 * A dictated topic context, recognised synchronously, as re-recognition is.
 * Nothing is stored: the context is not a card, and the user corrects the
 * text before sending it. Russian by default: a context is usually described
 * in Russian, and Speech-to-Text takes exactly one language (DictationLang).
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const file = form.get('audio')
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'audio is required' }, { status: 400 })
  const lang: DictationLang = form.get('lang') === 'pl' ? 'pl' : 'ru'
  try {
    const transcript = await getTranscriber().transcribe({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type || 'audio/webm',
      lang,
    })
    return NextResponse.json({ transcript })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
```

`app/api/topics/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { topicView, updateTopic } from '@/lib/topics/service'

const Patch = z.object({
  name: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  suspendedAt: z.number().int().nullable().optional(),
})

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const view = topicView(db, (await params).id)
  return view ? NextResponse.json(view) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const patch = Patch.safeParse(await req.json())
  if (!patch.success) return NextResponse.json({ error: 'bad patch' }, { status: 400 })
  const topic = updateTopic(db, id, patch.data)
  return topic ? NextResponse.json({ topic }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
```

`app/api/topics/[id]/rounds/[round]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { acceptRound } from '@/lib/topics/service'
import { RoundBody } from '@/lib/topics/body'

const Body = z.object({ rejected: z.array(z.string()), next: RoundBody.optional() })

/** Accepts a round: struck-out items rejected, the rest queued as cards; `next` asks for another (spec §6.3). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; round: string }> }) {
  const { id, round } = await params
  const n = Number(round)
  const body = Body.safeParse(await req.json())
  if (!Number.isInteger(n) || n < 0 || !body.success) return NextResponse.json({ error: 'bad round' }, { status: 400 })
  const result = acceptRound(db, id, n, body.data.rejected, body.data.next ?? null, new Date())
  return result ? NextResponse.json(result) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
```

`app/api/topics/[id]/retry/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { retrySuggest } from '@/lib/topics/service'

/** `spróbuj ponownie`: the failed round again. jobId is null when there was nothing to retry. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return NextResponse.json({ jobId: retrySuggest(db, (await params).id, new Date()) })
}
```

- [ ] **Step 4: Run the tests** — `npx vitest run app/api/topics` — PASS.
- [ ] **Step 5: Gates (the build matters here), then commit**

```bash
git add app/api/topics lib/topics
git commit -m "feat: topic endpoints"
```

---

### Task 9: The topic name on cards

**Files:**
- Modify: `app/api/cards/route.ts`, `app/api/cards/route.test.ts`, `app/api/cards/[id]/route.ts`, `app/api/cards/[id]/route.test.ts`, `app/fiszki/page.tsx`, `app/fiszki/page.dom.test.tsx`, `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`, `lib/topics/service.ts`

**Interfaces:**
- Produces: `topicNames(db): Record<string, string>` (topic id → name, named topics only) in `lib/topics/service.ts`; `GET /api/cards` adds `topicNames`; `GET /api/cards/:id` adds `topic: { id: string; name: string | null } | null`.

- [ ] **Step 1: Failing tests.**

`app/api/cards/route.test.ts` — add:

```ts
  it('names each card’s topic', async () => {
    db.insert(topics).values({ id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1 }).run()
    const body = await (await GET(new Request('http://test/api/cards'))).json()
    expect(body.topicNames).toEqual({ t1: 'U lekarza' })
  })
```

(Add `topics` to the schema import and `db.delete(topics).run()` to its `beforeEach`, after cards are deleted.)

`app/api/cards/[id]/route.test.ts` — add `topics` to its schema import and `db.delete(topics).run()` at the end of its `beforeEach` (after cards are deleted, since cards reference topics), then:

```ts
  it('names the card’s topic, or null without one', async () => {
    db.insert(topics).values({ id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1 }).run()
    seedCard({ id: 'k1', topicId: 't1' })
    seedCard({ id: 'k2', answerPl: 'kot', answerKey: 'kot' })
    expect((await (await get('k1')).json()).topic).toEqual({ id: 't1', name: 'U lekarza' })
    expect((await (await get('k2')).json()).topic).toBeNull()
  })
```

`app/fiszki/page.dom.test.tsx` — `stubFetch`'s `extra` gains `topicNames?: Record<string, string>`, returned as `topicNames: extra.topicNames ?? {}`. Add:

```ts
  it('shows a card’s topic name beside it', async () => {
    stubFetch(() => [cardRow({ id: 'a', answerPl: 'gorączka', topicId: 't1' })], { topicNames: { t1: 'U lekarza' } })
    render(<CardsPage />)
    expect(await screen.findByText('U lekarza')).toBeTruthy()
    expect(screen.getByText('U lekarza').closest('li')).toBe(screen.getByText('gorączka').closest('li'))
  })
```

`app/fiszki/[id]/page.dom.test.tsx` — add:

```tsx
  it('links to the card’s topic', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: cardRow(), captureId: null, generating: false, topic: { id: 't1', name: 'U lekarza' } }),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CardPage />)
    expect((await screen.findByText('U lekarza')).closest('a')?.getAttribute('href')).toBe('/tematy/t1')
  })
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run app/api/cards app/fiszki` — FAIL.

- [ ] **Step 3: Implement.**

`lib/topics/service.ts`:

```ts
/** Names of named topics, for showing beside cards. */
export function topicNames(db: Db): Record<string, string> {
  return Object.fromEntries(
    db.select({ id: topics.id, name: topics.name }).from(topics).where(isNotNull(topics.name)).all().map((t) => [t.id, t.name!]),
  )
}
```

`app/api/cards/route.ts` `GET` adds `topicNames: topicNames(db),`.

`app/api/cards/[id]/route.ts` `GET` adds, before the response:

```ts
  const topic = card.topicId
    ? (db.select({ id: topics.id, name: topics.name }).from(topics).where(eq(topics.id, card.topicId)).get() ?? null)
    : null
```

and returns `{ card, captureId: ..., generating: ..., topic }`.

`app/fiszki/page.tsx`: add `const [topicNames, setTopicNames] = useState<Record<string, string>>({})`, set it from `body.topicNames` in `load`, and inside the badge `<span>` of each card row, first:

```tsx
                {c.topicId && topicNames[c.topicId] && (
                  <span className="text-neutral-400">{topicNames[c.topicId]}</span>
                )}
```

`app/fiszki/[id]/page.tsx`: keep `topic` from the GET in state (`useState<{ id: string; name: string | null } | null>(null)`), and render under the back link:

```tsx
      {topic && (
        <Link href={`/tematy/${topic.id}`} className="text-sm text-neutral-500 underline">
          {topic.name ?? t.unnamedTopic}
        </Link>
      )}
```

Add to `i18n/pl.ts` (used here and in Tasks 10–11): `unnamedTopic: 'nowy temat…',`.

- [ ] **Step 4: Run the tests** — `npx vitest run app i18n` — PASS.
- [ ] **Step 5: Gates, then commit**

```bash
git add app/api/cards app/fiszki lib/topics/service.ts i18n/pl.ts
git commit -m "feat: cards show the topic they belong to"
```

---

### Task 10: Navigation, the topic list and a new topic

**Files:**
- Create: `components/RoundSettings.tsx`, `components/RoundSettings.dom.test.tsx`, `app/tematy/page.tsx`, `app/tematy/page.dom.test.tsx`, `app/tematy/nowy/page.tsx`, `app/tematy/nowy/page.dom.test.tsx`
- Modify: `components/Nav.tsx`, `i18n/pl.ts`, `i18n/pl.test.ts`

**Interfaces:**
- Consumes: Task 8's endpoints; `COUNTS`, `MIXES`, `DEFAULT_COUNT`, `RoundParams` (Task 1).
- Produces: `<RoundSettings value={RoundParams} onChange={(p: RoundParams) => void} />`, reused by Task 11.

- [ ] **Step 1: Strings.** Add to `i18n/pl.ts`:

```ts
  topics: 'Tematy',
  newTopic: 'nowy temat',
  topicContext: 'Sytuacja',
  topicContextPlaceholder: 'Opisz sytuację: dokąd idziesz, z kim, po co…',
  propose: 'zaproponuj',
  searching: 'szukam…',
  acceptAndMore: 'przyjmij i jeszcze',
  acceptAndFinish: 'przyjmij i zakończ',
  more: 'jeszcze',
  tryAgain: 'spróbuj ponownie',
  roundCount: 'ile',
  mixMixed: 'mieszane',
  mixWords: 'więcej słów',
  mixPhrases: 'więcej fraz',
  kindWord: 'słowo',
  kindPhrase: 'fraza',
  topicOn: 'włączony',
  topicOff: 'wyłączony',
  topicNotFound: 'Nie ma takiego tematu',
  backToTopics: '‹ Tematy',
  transcribeFailed: 'nie udało się rozpoznać',
  topicSaveFailed: 'nie udało się zapisać',
  holdToDictate: 'przytrzymaj i opowiedz',
```

and add `'topics', 'newTopic', 'propose', 'searching', 'acceptAndMore', 'acceptAndFinish', 'tryAgain'` to the `required` list in `i18n/pl.test.ts`. Run `npx vitest run i18n` — PASS (the no-Cyrillic test covers the new strings).

- [ ] **Step 2: Failing component and page tests.**

`components/RoundSettings.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { RoundSettings } from './RoundSettings'

afterEach(cleanup)

describe('RoundSettings', () => {
  it('offers exactly 5, 10 and 20, and reports a change', () => {
    const onChange = vi.fn()
    render(<RoundSettings value={{ count: 10, mix: 'mieszane' }} onChange={onChange} />)
    const select = screen.getByLabelText(t.roundCount) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['5', '10', '20'])
    fireEvent.change(select, { target: { value: '20' } })
    expect(onChange).toHaveBeenCalledWith({ count: 20, mix: 'mieszane' })
  })

  it('switches the mix, marking the current one', () => {
    const onChange = vi.fn()
    render(<RoundSettings value={{ count: 10, mix: 'slowa' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: t.mixWords }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: t.mixPhrases }))
    expect(onChange).toHaveBeenCalledWith({ count: 10, mix: 'frazy' })
  })
})
```

`app/tematy/page.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const TopicsPage = (await import('./page')).default

const row = (over = {}) => ({
  id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1, cardCount: 23, pendingCount: 4, ...over,
})

function stubFetch(topics: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ topics }) }) as unknown as Promise<Response>
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TopicsPage', () => {
  it('lists each topic with its counts, linking to it', async () => {
    stubFetch([row()])
    render(<TopicsPage />)
    const name = await screen.findByText('U lekarza')
    expect(name.closest('a')?.getAttribute('href')).toBe('/tematy/t1')
    expect(screen.getByText('23')).toBeTruthy()
    expect(screen.getByText(`+4 ${t.queued}`)).toBeTruthy()
  })

  it('links to a new topic', async () => {
    stubFetch([])
    render(<TopicsPage />)
    expect(screen.getByText(t.newTopic).closest('a')?.getAttribute('href')).toBe('/tematy/nowy')
  })

  it('switches a topic off', async () => {
    const calls = stubFetch([row()])
    render(<TopicsPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.topicOn }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/topics/t1')
    expect(JSON.parse(String(patch.init!.body)).suspendedAt).toEqual(expect.any(Number))
  })

  it('shows an unnamed topic as such', async () => {
    stubFetch([row({ name: null })])
    render(<TopicsPage />)
    expect(await screen.findByText(t.unnamedTopic)).toBeTruthy()
  })
})
```

`app/tematy/nowy/page.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const NewTopicPage = (await import('./page')).default

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  push.mockReset()
})

describe('NewTopicPage', () => {
  it('creates the topic with the context and settings, then opens it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ topicId: 't9' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<NewTopicPage />)
    fireEvent.change(screen.getByLabelText(t.topicContext), { target: { value: 'u mechanika, wymiana sprzęgła' } })
    fireEvent.click(screen.getByRole('button', { name: t.mixPhrases }))
    fireEvent.click(screen.getByRole('button', { name: t.propose }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tematy/t9'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/topics')
    expect(JSON.parse(init.body)).toEqual({ context: 'u mechanika, wymiana sprzęgła', count: 10, mix: 'frazy' })
  })

  it('cannot propose with an empty context', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<NewTopicPage />)
    expect((screen.getByRole('button', { name: t.propose }) as HTMLButtonElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 3: Run to see them fail** — `npx vitest run components/RoundSettings.dom.test.tsx app/tematy` — FAIL: modules missing.

- [ ] **Step 4: Implement.**

`components/RoundSettings.tsx`:

```tsx
'use client'
import { COUNTS, MIXES, type Mix, type RoundParams } from '@/lib/topics/rounds'
import { t } from '@/i18n/pl'

const MIX_LABEL: Record<Mix, string> = { mieszane: t.mixMixed, slowa: t.mixWords, frazy: t.mixPhrases }

/** How big the next round is and how it leans (spec 2026-09-18-topic-generation §2). */
export function RoundSettings({ value, onChange }: { value: RoundParams; onChange: (p: RoundParams) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        {t.roundCount}
        <select
          value={value.count}
          onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
          className="rounded border p-1"
        >
          {COUNTS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="flex overflow-hidden rounded border">
        {MIXES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value.mix === m}
            onClick={() => onChange({ ...value, mix: m })}
            className={`px-2 py-1 ${value.mix === m ? 'bg-black text-white' : ''}`}
          >
            {MIX_LABEL[m]}
          </button>
        ))}
      </div>
    </div>
  )
}
```

`app/tematy/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/** Every topic, with its card count, what is still generating, and its on/off switch (spec §4.2). */
export default function TopicsPage() {
  const [topics, setTopics] = useState<TopicListRow[]>([])

  const load = useCallback(async () => {
    const res = await fetch('/api/topics')
    setTopics(((await res.json()) as { topics: TopicListRow[] }).topics)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pending = topics.some((x) => x.pendingCount > 0)
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [pending, load])

  async function toggle(topic: TopicListRow) {
    await fetch(`/api/topics/${topic.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suspendedAt: topic.suspendedAt === null ? Date.now() : null }),
    }).catch(() => {})
    await load().catch(() => {})
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy/nowy" className="self-start rounded bg-black px-4 py-2 text-white">
        {t.newTopic}
      </Link>
      <ul>
        {topics.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-3 border-b py-3">
            <Link href={`/tematy/${x.id}`} className={`text-lg ${x.suspendedAt !== null ? 'text-neutral-400' : ''}`}>
              {x.name ?? t.unnamedTopic}
            </Link>
            <span className="flex shrink-0 items-center gap-3 text-xs">
              <span>{x.cardCount}</span>
              {x.pendingCount > 0 && <span className="text-sky-700">{`+${x.pendingCount} ${t.queued}`}</span>}
              <button
                type="button"
                onClick={() => void toggle(x)}
                className="rounded border px-2 py-1"
              >
                {x.suspendedAt === null ? t.topicOn : t.topicOff}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

`app/tematy/nowy/page.tsx`:

```tsx
'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { mediaRecorderFactory, useHoldToRecord } from '@/hooks/useHoldToRecord'
import { RoundSettings } from '@/components/RoundSettings'
import { DEFAULT_COUNT, type RoundParams } from '@/lib/topics/rounds'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'

/**
 * A new topic: describe the situation by typing or by holding the mic (spec
 * §4.3). A recording is recognised straight into the text area for
 * correction; it never becomes a capture.
 */
export default function NewTopicPage() {
  const router = useRouter()
  const [context, setContext] = useState('')
  const [params, setParams] = useState<RoundParams>({ count: DEFAULT_COUNT, mix: 'mieszane' })
  const [lang, setLang] = useState<DictationLang>('ru')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const factory = useMemo(
    () =>
      mediaRecorderFactory(async () => (streamRef.current ??= await navigator.mediaDevices.getUserMedia({ audio: true }))),
    [],
  )

  const onRecorded = useCallback(
    async (bytes: ArrayBuffer, mime: string) => {
      setError(null)
      const form = new FormData()
      form.set('audio', new Blob([bytes], { type: mime }))
      form.set('lang', lang)
      try {
        const res = await fetch('/api/topics/transcribe', { method: 'POST', body: form })
        const body = (await res.json()) as { transcript?: string }
        if (!res.ok || !body.transcript) throw new Error()
        setContext((c) => (c.trim() ? `${c.trim()} ${body.transcript}` : body.transcript!))
      } catch {
        setError(t.transcribeFailed)
      }
    },
    [lang],
  )

  const { recording, start, stop } = useHoldToRecord({ factory, onRecorded })

  async function propose() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: context.trim(), ...params }),
      })
      if (!res.ok) throw new Error()
      router.push(`/tematy/${((await res.json()) as { topicId: string }).topicId}`)
    } catch {
      setError(t.topicSaveFailed)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        {t.topicContext}
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder={t.topicContextPlaceholder}
          rows={4}
          className="rounded border p-3"
        />
      </label>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={`select-none rounded-full px-4 py-3 text-white ${recording ? 'bg-red-600' : 'bg-black'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          {t.holdToDictate}
        </button>
        {(['ru', 'pl'] as const).map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={lang === l ? 'underline' : 'text-neutral-500'}
          >
            {l === 'ru' ? t.asRussian : t.asPolish}
          </button>
        ))}
      </div>
      <RoundSettings value={params} onChange={setParams} />
      <button
        type="button"
        disabled={busy || context.trim() === ''}
        onClick={() => void propose()}
        className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-40"
      >
        {t.propose}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
```

`components/Nav.tsx`: add `{ href: '/tematy', label: t.topics },` after the `/fiszki` link.

- [ ] **Step 5: Run the tests** — `npx vitest run components app/tematy i18n` — PASS.
- [ ] **Step 6: Gates, then commit**

```bash
git add components/Nav.tsx components/RoundSettings.tsx components/RoundSettings.dom.test.tsx app/tematy i18n
git commit -m "feat: topic list and new-topic screen"
```

---

### Task 11: The topic page

**Files:**
- Create: `app/tematy/[id]/page.tsx`, `app/tematy/[id]/page.dom.test.tsx`

**Interfaces:**
- Consumes: `GET/PATCH /api/topics/:id`, `POST /api/topics/:id/rounds/:round`, `POST /api/topics/:id/retry` (Task 8); `TopicView` (Task 6); `RoundSettings` (Task 10).

- [ ] **Step 1: Failing tests** — `app/tematy/[id]/page.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 't1' }) }))

const TopicPage = (await import('./page')).default

function view(over = {}) {
  return {
    topic: { id: 't1', name: 'U lekarza', context: 'z dzieckiem, grypa', suspendedAt: null, createdAt: 1 },
    state: 'ready',
    error: null,
    round: 1,
    items: [
      { id: 's1', answerPl: 'gorączka', glossRu: 'температура, жар', kind: 'slowo' },
      { id: 's2', answerPl: 'ma gorączkę od wczoraj', glossRu: 'у него температура со вчера', kind: 'fraza' },
    ],
    cards: [],
    pending: [],
    ...over,
  }
}

function stubFetch(v: () => unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = init?.method === 'POST' ? { accepted: 1, nextJobId: null, jobId: 'j' } : v()
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }) as unknown as Promise<Response>
  }))
  return calls
}

const posts = (calls: { url: string; init?: RequestInit }[]) => calls.filter((c) => c.init?.method === 'POST')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TopicPage', () => {
  it('shows the round as Polish with its Russian gloss', async () => {
    stubFetch(() => view())
    render(<TopicPage />)
    expect(await screen.findByText('gorączka')).toBeTruthy()
    expect(screen.getByText('температура, жар')).toBeTruthy()
    expect(screen.getByText(t.kindPhrase)).toBeTruthy()
  })

  it('strikes an item out and restores it on a second tap', async () => {
    stubFetch(() => view())
    render(<TopicPage />)
    const item = (await screen.findByText('gorączka')).closest('button')!
    fireEvent.click(item)
    expect(item.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(item)
    expect(item.getAttribute('aria-pressed')).toBe('false')
  })

  it('accepts the rest and finishes', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    fireEvent.click((await screen.findByText('gorączka')).closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: t.acceptAndFinish }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0].url).toBe('/api/topics/t1/rounds/1')
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: ['s1'] })
  })

  it('accepts the rest and asks for another round with the chosen settings', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    await screen.findByText('gorączka')
    fireEvent.click(screen.getByRole('button', { name: t.mixWords }))
    fireEvent.click(screen.getByRole('button', { name: t.acceptAndMore }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: [], next: { count: 10, mix: 'slowa' } })
  })

  it('offers only "more" once the round is decided', async () => {
    const calls = stubFetch(() => view({ state: 'idle', items: [] }))
    render(<TopicPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.more }))
    expect(screen.queryByRole('button', { name: t.acceptAndFinish })).toBeNull()
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: [], next: { count: 10, mix: 'mieszane' } })
  })

  it('says it is searching while a round is in flight', async () => {
    stubFetch(() => view({ state: 'searching', items: [] }))
    render(<TopicPage />)
    expect(await screen.findByText(t.searching)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.more })).toBeNull()
  })

  it('shows a failed round with its error and a retry', async () => {
    const calls = stubFetch(() => view({ state: 'failed', error: 'unusable payload', items: [] }))
    render(<TopicPage />)
    expect(await screen.findByText('unusable payload')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.tryAgain }))
    await waitFor(() => expect(posts(calls).map((c) => c.url)).toEqual(['/api/topics/t1/retry']))
  })

  it('lists pending items above the topic’s cards', async () => {
    stubFetch(() =>
      view({
        pending: [{ id: 'c1', transcript: 'osłuchać', status: 'queued' }],
        cards: [{ id: 'k1', answerPl: 'katar' }],
      }),
    )
    render(<TopicPage />)
    expect(await screen.findByText('osłuchać')).toBeTruthy()
    expect(screen.getByText('katar').closest('a')?.getAttribute('href')).toBe('/fiszki/k1')
  })

  it('switches the topic off', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.topicOn }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
  })

  it('says so for an unknown topic', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
    render(<TopicPage />)
    expect(await screen.findByText(t.topicNotFound)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run app/tematy/\[id\]` — FAIL: module missing.

- [ ] **Step 3: Implement** — `app/tematy/[id]/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { RoundSettings } from '@/components/RoundSettings'
import { DEFAULT_COUNT, type RoundParams } from '@/lib/topics/rounds'
import type { TopicView } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/**
 * One topic (spec 2026-09-18-topic-generation §4.4): its current round, the
 * controls for the next, and its cards. Struck-out items live only here until
 * an accept button sends them; leaving the page accepts nothing.
 */
export default function TopicPage() {
  const { id } = useParams<{ id: string }>()
  const [view, setView] = useState<TopicView | null>(null)
  const [missing, setMissing] = useState(false)
  const [struck, setStruck] = useState<ReadonlySet<string>>(() => new Set())
  const [params, setParams] = useState<RoundParams>({ count: DEFAULT_COUNT, mix: 'mieszane' })
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/topics/${id}`)
    if (!res.ok) {
      setMissing(true)
      return
    }
    setView((await res.json()) as TopicView)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // A new round replaces the list; strikes belonged to the old one.
  const round = view?.round
  useEffect(() => {
    setStruck(new Set())
  }, [round])

  const waiting = view !== null && (view.state === 'searching' || view.pending.length > 0)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void load(), 2_000)
    return () => clearInterval(timer)
  }, [waiting, load])

  async function post(url: string, body?: unknown) {
    setBusy(true)
    setSaveError(false)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
    } catch {
      setSaveError(true)
    }
    await load().catch(() => {})
    setBusy(false)
  }

  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/topics/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }).catch(() => setSaveError(true))
    await load().catch(() => {})
  }

  function accept(more: boolean) {
    const body = more ? { rejected: [...struck], next: params } : { rejected: [...struck] }
    void post(`/api/topics/${id}/rounds/${view!.round}`, body)
  }

  function toggle(itemId: string) {
    setStruck((s) => {
      const next = new Set(s)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  if (missing) return <p>{t.topicNotFound}</p>
  if (!view) return null
  const { topic } = view

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy" className="text-sm underline">{t.backToTopics}</Link>

      <div className="flex items-center justify-between gap-3">
        <input
          key={topic.name ?? ''}
          defaultValue={topic.name ?? ''}
          placeholder={t.unnamedTopic}
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (name && name !== topic.name) void patch({ name })
          }}
          className="min-w-0 flex-1 text-xl"
        />
        <button
          type="button"
          onClick={() => void patch({ suspendedAt: topic.suspendedAt === null ? Date.now() : null })}
          className="shrink-0 rounded border px-2 py-1 text-xs"
        >
          {topic.suspendedAt === null ? t.topicOn : t.topicOff}
        </button>
      </div>

      <details>
        <summary className="text-sm text-neutral-500">{t.topicContext}</summary>
        <textarea
          key={topic.context}
          defaultValue={topic.context}
          rows={3}
          onBlur={(e) => {
            const context = e.target.value.trim()
            if (context && context !== topic.context) void patch({ context })
          }}
          className="mt-2 w-full rounded border p-2"
        />
      </details>

      {view.state === 'searching' && <p className="text-neutral-500">{t.searching}</p>}

      {view.state === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">{view.error}</p>
          <button type="button" disabled={busy} onClick={() => void post(`/api/topics/${id}/retry`)} className="self-start underline">
            {t.tryAgain}
          </button>
        </div>
      )}

      {view.state === 'ready' && (
        <ul>
          {view.items.map((item) => {
            const off = struck.has(item.id)
            return (
              <li key={item.id} className="border-b">
                <button
                  type="button"
                  aria-pressed={off}
                  onClick={() => toggle(item.id)}
                  className={`flex w-full items-baseline justify-between gap-3 py-3 text-left ${off ? 'text-neutral-400 line-through' : ''}`}
                >
                  <span>
                    <span className="text-lg">{item.answerPl}</span>
                    {' — '}
                    <span>{item.glossRu}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {item.kind === 'fraza' ? t.kindPhrase : t.kindWord}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {(view.state === 'ready' || view.state === 'idle') && (
        <div className="flex flex-col gap-3">
          <RoundSettings value={params} onChange={setParams} />
          <div className="flex gap-3">
            <button type="button" disabled={busy} onClick={() => accept(true)} className="rounded bg-black px-4 py-2 text-white disabled:opacity-40">
              {view.state === 'ready' ? t.acceptAndMore : t.more}
            </button>
            {view.state === 'ready' && (
              <button type="button" disabled={busy} onClick={() => accept(false)} className="rounded border px-4 py-2 disabled:opacity-40">
                {t.acceptAndFinish}
              </button>
            )}
          </div>
        </div>
      )}

      {saveError && <p className="text-sm text-red-600">{t.topicSaveFailed}</p>}

      <ul>
        {view.pending.map((p) => (
          <li key={`pending:${p.id}`} className="flex items-baseline justify-between gap-3 border-b py-3 text-neutral-500">
            <span className="text-lg">{p.transcript}</span>
            <span className="shrink-0 text-xs">{p.status === 'generating' ? t.generating : t.queued}</span>
          </li>
        ))}
        {view.cards.map((c) => (
          <li key={c.id} className="border-b">
            <Link href={`/fiszki/${c.id}`} className="block py-3 text-lg">{c.answerPl}</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

The `idle` state's single button reads `jeszcze` and posts the (empty) current round with `next`, which is exactly "ask for another round" (§4.4, §6.3).

- [ ] **Step 4: Run the tests** — `npx vitest run app/tematy` — PASS.
- [ ] **Step 5: Gates, then commit**

```bash
git add app/tematy
git commit -m "feat: the topic page — strike out, accept, ask for more"
```

---

### Task 12: Live prompt check

**Files:**
- Create: `scripts/try-suggestions.ts`

A throwaway-quality probe that is kept, like `check-providers`, because the prompt will be tuned again. It is run by the controller, who has credentials; the implementer only writes it and checks it typechecks.

- [ ] **Step 1: Write it** — `scripts/try-suggestions.ts`:

```ts
// Live check of the suggestion prompt (spec 2026-09-18-topic-generation §7):
// one round for each of the three example situations, printed for a human to
// judge. Not a test — the question is whether the words are good.
//
// Usage: npx tsx --env-file=.env.local scripts/try-suggestions.ts [count] [mix]
// Needs GOOGLE_CLOUD_PROJECT, FISZKI_MODEL and ADC, like check-providers.

import { getSuggester } from '../lib/generate/index'
import { MIXES, mixTarget, requestSize, type Mix } from '../lib/topics/rounds'

const SITUATIONS = [
  'Иду к врачу с ребёнком, у него грипп: температура, кашель, насморк.',
  'Я программист, работаю над проектом на C++, пользуюсь git и Windows.',
  'Везу машину в сервис.',
]

const count = Number(process.argv[2] ?? 10)
const mix = (process.argv[3] ?? 'mieszane') as Mix
if (!MIXES.includes(mix)) throw new Error(`mix must be one of ${MIXES.join(', ')}`)

const suggester = getSuggester()
for (const context of SITUATIONS) {
  const n = requestSize(count)
  const started = Date.now()
  const s = await suggester.suggest({ context, count: n, ...mixTarget(n, mix), exclude: [] })
  console.log(`\n=== ${s.topic_name}  (${Date.now() - started} ms)\n${context}`)
  for (const i of s.items) console.log(`  [${i.kind}] ${i.answer_pl} — ${i.gloss_ru}`)
}
```

- [ ] **Step 2: Gates, then commit**

```bash
git add scripts/try-suggestions.ts
git commit -m "chore: a live check for the suggestion prompt"
```

- [ ] **Step 3 (controller):** run it locally or on the VM (`sudo bash -c 'set -a; . /etc/fiszki.env; set +a; cd /opt/fiszki; exec sudo -E -u fiszki npx tsx scripts/try-suggestions.ts'`). Show the output to the user. Check: no English; no everyday basics (`lekarz`, `dziecko`, `samochód`); the word/phrase split roughly matches; glosses short; diacritics present. Tune `SUGGEST_SYSTEM` with the user if not, re-running each time.

---

### Task 13: Deploy and verify (controller-only)

Done by the controller, not delegated. Deploy facts are in memory (`fiszki-vm-deployment`). **This deploy keeps the database.**

- [ ] **Step 1: Gates on the finished branch** — all three clean.
- [ ] **Step 2: Back up first.** `systemctl start fiszki-backup.service` on the VM, and confirm a new object in the backups bucket.
- [ ] **Step 3: Fresh-tree swap, detached:** extract to `/opt/fiszki.new`, `npm ci`, `npm run build` while the old app serves; then stop, swap, chown, start. `setsid nohup`, poll the log; `ssh … </dev/null`.
- [ ] **Step 4: Verify.** `_migrations` lists `003-topics.sql`; `topics` and `suggestions` exist; card count unchanged; `journalctl -u fiszki` shows `generation worker started`; `npm run check-providers` passes.
- [ ] **Step 5: End to end on the VM, without the phone.** Log in; `POST /api/topics` with the car-service context; poll `GET /api/topics/:id` until `state` is `ready`; accept all but one item; watch `pending` drain into `cards`; `PATCH` the topic `suspendedAt` and confirm its cards are gone from `GET /api/review/queue`, then back after clearing it.
- [ ] **Step 6: On the phone.** Ask the user to dictate a situation, run two rounds, and switch the topic off and on.
- [ ] **Step 7: Update memory** with the deploy date and anything the deploy taught.
