# Topic Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A topic becomes a standing list of items in three groups, **z kartą**, **bez karty** and **odrzucone**:
- each item has its own `+ karta` / `✕` / `przywróć`;
- items can be added by hand;
- batches take a mix of `mieszane · tylko słowa · tylko frazy` and a per-batch level;
- items and cards can move between topics;
- every card belongs to a topic, and dictations go to a default topic, **Ogólne**.

**Architecture:** Approach B from the spec. Live cards are the **z kartą** group. The `suggestions` table becomes `topic_items` (migration 005) and holds everything that is not a live card. Discarding a card is its existing soft delete, and restoring clears `deleted_at`. Rounds disappear: a `suggest` job adds `open` items tagged with its own id. `lib/topics/service.ts` owns every topic, item and card-move rule; routes stay thin; the topic page is rebuilt around three tabs.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, SQLite (better-sqlite3) + Drizzle, hand-written SQL migrations, Vitest + jsdom, Gemini on Vertex, Google Speech-to-Text v2.

**Spec:** `docs/superpowers/specs/2026-09-19-topic-items-design.md`. Read it before any task. Where this plan and the spec disagree, the spec wins; stop and report.

This plan adds three refinements the spec leaves open:
1. The default topic has the fixed id `'default'`, so code never looks it up.
2. `topic_items.discarded_at` records when an item was discarded, so **odrzucone** can be ordered newest first. For a card, `deleted_at` does the same job.
3. `knownCardFor`, the deck match that handles Cyrillic, moves from `lib/capture/pipeline.ts` to `lib/cards/service.ts`, so the topic service can use it without an import cycle.

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, and `npm run build` exits 0. Read each gate's output before committing. Never chain a commit after a test command with `&&`.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed. When a task removes behaviour, delete its tests with it and say so.
- **Every comment must be true when committed.** Many comments about rounds, "accept the round", and topic-less cards become false here.
- **Migrations are append-only.** This plan adds exactly one, `migrations/005-topic-items.sql`. Never edit 001–004. The deployed database holds real cards.
- **Clock is injected:** every stateful function takes `now: Date`.
- **No HTTP handler calls Gemini.** Speech-to-Text stays synchronous in requests.
- **Exact values:**
  - Default topic: id `'default'`, name `Ogólne`, `is_default = 1`, context `''`.
  - Item statuses: `open | discarded | carded`. Item sources: `suggested | manual`.
  - Levels: `zaawansowany | sredni`. Mixes: `mieszane | slowa | frazy`, with word share `0.5 | 1 | 0`. Counts: `5 | 10 | 20`, default `10`.
  - Request size is `ceil(count × 1.5)`.
- **Error texts:** the 409 texts are Polish: `już jest w tym temacie` and `już masz — w temacie <name>`.
- **UI strings:** all live in `i18n/pl.ts`, in Polish, with no Cyrillic.
- **Do not change `FISZKI_MODEL`.**
- `app/dodaj/page.dom.test.tsx` is intermittently flaky. If it alone fails, re-run it and report both runs.

## File map

| File | Responsibility | Task |
|---|---|---|
| `lib/topics/rounds.ts`, `lib/generate/index.ts` | levels; only-words and only-phrases; a batch filtered by mix; the level line in the prompt; a meaning with an optional gloss or context | 1 |
| `migrations/005-topic-items.sql`, `lib/db/schema.ts`, `lib/topics/service.ts`, `lib/cards/service.ts`, `lib/capture/pipeline.ts`, `app/api/topics/**` (the rounds route is deleted) | the new tables; the storage port; the default topic; linking an item to its card | 2 |
| `lib/topics/service.ts`, `lib/cards/service.ts` | item and card actions: `+ karta`, discard, restore, move, add by hand | 3 |
| `app/api/topics/**`, `app/api/cards/**`, `lib/topics/body.ts` | endpoints | 4 |
| `components/BatchSettings.tsx` (replaces `RoundSettings.tsx`), `components/MoveToTopic.tsx`, `components/ManualAddBar.tsx`, `components/CardListItem.tsx`, `i18n/pl.ts` | building blocks | 5 |
| `app/tematy/[id]/page.tsx` | the topic page | 6 |
| `app/tematy/page.tsx`, `app/tematy/nowy/page.tsx`, `app/fiszki/[id]/page.tsx` | list, new topic, card page | 7 |
| `scripts/try-suggestions.ts` | live probe with level and mix | 8 |

---

### Task 1: Levels, only-kinds, and meaning without a gloss

**Files:**
- Modify: `lib/topics/rounds.ts`, `lib/topics/rounds.test.ts`, `lib/generate/index.ts`, `lib/generate/index.test.ts`

**Interfaces:**
- Produces:
  - `LEVELS = ['zaawansowany', 'sredni'] as const`, `type Level`.
  - `type BatchParams = { count: number; mix: Mix; level: Level }`. This replaces `RoundParams`: update every importer (`components/RoundSettings.tsx`, the pages, `lib/topics/service.ts`, `lib/topics/body.ts`) to `BatchParams`, with `level` defaulting to `'zaawansowany'` at those call sites for now. Later tasks replace them.
  - `mixTarget(n, mix)` with word share `mieszane 0.5 / slowa 1 / frazy 0`.
  - `pickBatch(items, taken, count, mix): SuggestedItem[]`, renamed from `pickRound`. With `slowa` it keeps only `kind === 'slowo'`, with `frazy` only `kind === 'fraza'`, and it applies that filter after deduplication.
  - `SuggestInput` gains `level: Level`. `suggestMessage` adds one level line.
  - `Meaning = { glossRu: string | null; context: string | null }`. `dictationMessage` prints a gloss sentence and/or a situation sentence.

- [ ] **Step 1: Failing tests.**

`lib/topics/rounds.test.ts`: rename the `pickRound` tests to `pickBatch`, passing `'mieszane'` as the fourth argument. Update `mixTarget(15,'slowa')` to `{ words: 15, phrases: 0 }` and `mixTarget(15,'frazy')` to `{ words: 0, phrases: 15 }`. Add:

```ts
  it('keeps only words for slowa and only phrases for frazy, after dedup', () => {
    const items = [item('katar'), item('ma gorączkę', 'fraza'), item('kaszel'), item('boli go gardło', 'fraza')]
    expect(pickBatch(items, new Set(['katar']), 10, 'slowa').map((i) => i.answer_pl)).toEqual(['kaszel'])
    expect(pickBatch(items, new Set(), 1, 'frazy').map((i) => i.answer_pl)).toEqual(['ma gorączkę'])
  })
```

`lib/generate/index.test.ts`: update every `suggestMessage` / `suggest` input to carry `level: 'zaawansowany'`, then add:

```ts
describe('level in the suggestion prompt', () => {
  const base = { context: 'u lekarza', count: 15, words: 8, phrases: 7, exclude: [] as string[] }

  it('asks an advanced batch to skip everyday basics', () => {
    expect(suggestMessage({ ...base, level: 'zaawansowany' })).toContain('Уровень: продвинутый')
  })

  it('asks an intermediate batch for common situational vocabulary', () => {
    const m = suggestMessage({ ...base, level: 'sredni' })
    expect(m).toContain('Уровень: средний (B1)')
    expect(m).not.toContain('продвинутый')
  })

  it('keeps the level out of the system prompt', async () => {
    const generate = ok(SUGGESTION)
    await geminiSuggester({ generate: generate as never, model: 'm' }).suggest({ ...base, level: 'sredni' })
    expect(generate.mock.calls[0][0].config.systemInstruction).not.toContain('B1')
  })
})

describe('dictationMessage with a partial meaning', () => {
  it('names only the gloss when there is no situation', () => {
    const m = dictationMessage('x', { glossRu: 'насморк', context: null })
    expect(m).toContain('«насморк»')
    expect(m).not.toContain('Ситуация')
  })

  it('names only the situation when there is no gloss', () => {
    const m = dictationMessage('x', { glossRu: null, context: 'u mechanika' })
    expect(m).toContain('«u mechanika»')
    expect(m).not.toContain('Имеется в виду')
  })

  it('is byte-identical to before when both are present', () => {
    expect(dictationMessage('x', { glossRu: 'a', context: 'b' })).toBe(
      'Продиктовано: «x»\n\nИмеется в виду значение: «a». Ситуация, для которой нужна карточка: «b».\n\nСделай карточку.',
    )
  })
})
```

- [ ] **Step 2: Run and watch them fail.** `npx vitest run lib/topics lib/generate` should fail: there is no `pickBatch`, no level line, and `Meaning` requires `glossRu`.

- [ ] **Step 3: Implement.**

`lib/topics/rounds.ts`:
- Add `LEVELS`/`Level`.
- Replace `RoundParams` with `BatchParams`.
- Set `WORD_SHARE` to `{ mieszane: 0.5, slowa: 1, frazy: 0 }`.
- Rename `pickRound` to `pickBatch(items, taken, count, mix)`. After the `seen` check, add `if (mix === 'slowa' && it.kind !== 'slowo') continue` and `if (mix === 'frazy' && it.kind !== 'fraza') continue`.
- Update the doc comments: batches, not rounds, and "only" means 100%.

`lib/generate/index.ts`:
- In `SUGGEST_SYSTEM`, replace the first rule bullet with one that is independent of level:

```
- Уровень человека указан в запросе — подбирай лексику под него. Базовые слова вроде «lekarz», «dziecko», «chory» не предлагай ни на каком уровне.
```

- `SuggestInput` gains `level: Level`, imported as a type from `../topics/rounds`.
- `suggestMessage` inserts a line after the situation line:

```ts
const LEVEL_LINE: Record<Level, string> = {
  zaawansowany:
    'Уровень: продвинутый. Человек свободно говорит по-польски — не предлагай повседневную лексику; предлагай то, что специфично для ситуации и чего ему, скорее всего, не хватает: термины, устойчивые сочетания, типичные вопросы и ответы.',
  sredni:
    'Уровень: средний (B1). Человек уверенно объясняется по-польски, но в этой области лексики ему не хватает: предлагай употребительные слова и фразы этой ситуации, которых B1 может не знать; самые базовые не предлагай.',
}
```

- `Meaning` becomes `{ glossRu: string | null; context: string | null }`. `dictationMessage` builds the middle line from whichever parts are present:

```ts
export function dictationMessage(text: string, meaning?: Meaning): string {
  const lines = [`Продиктовано: «${text}»`]
  const parts = [
    meaning?.glossRu ? `Имеется в виду значение: «${meaning.glossRu}».` : null,
    meaning?.context ? `Ситуация, для которой нужна карточка: «${meaning.context}».` : null,
  ].filter(Boolean)
  if (parts.length > 0) lines.push(parts.join(' '))
  lines.push('Сделай карточку.')
  return lines.join('\n\n')
}
```

- Fix the callers so `tsc` passes. `lib/topics/service.ts` passes `level: params.level ?? 'zaawansowany'` for now; `parseRoundJob` gains an optional `level` defaulting to `'zaawansowany'`. `meaningOf` in `lib/capture/pipeline.ts` compiles unchanged. Task 2 rewrites both.
- [ ] **Step 4: Run the tests.** `npx vitest run lib app components` should pass.
- [ ] **Step 5: Gates, then commit.**

```bash
git commit -am "feat: batch levels and only-words/only-phrases; a meaning may lack its gloss"
```

---

### Task 2: Migration 005 and the storage port

**Files:**
- Create: `migrations/005-topic-items.sql`, `lib/topics/default.ts`
- Modify: `lib/db/schema.ts`, `lib/db/schema-shape.test.ts`, `lib/topics/service.ts`, `lib/topics/service.test.ts`, `lib/cards/service.ts`, `lib/cards/service.test.ts`, `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `app/api/topics/route.ts`, `app/api/topics/route.test.ts`, and every test that expected a card's `topicId` to be null
- Delete: `app/api/topics/[id]/rounds/[round]/route.ts`. The topic page's calls to it stay until Task 6, which is fine for `tsc`.

**Interfaces:**
- Produces:
  - `lib/topics/default.ts`: `DEFAULT_TOPIC_ID = 'default'`.
  - Drizzle `topicItems`: `id, topicId, answerPl, glossRu | null, kind | null, source, level | null, status, captureId | null, cardId | null, batchJobId | null, discardedAt | null, createdAt`. `topics.isDefault: boolean` (Drizzle `integer({ mode: 'boolean' })`). The `suggestions` export is removed.
  - `createCard` assigns `input.topicId ?? DEFAULT_TOPIC_ID`.
  - `lib/topics/service.ts`:
    - `parseBatchJob(json): BatchParams`;
    - `enqueueSuggest(db, topicId, params: BatchParams, now): string | null`, which returns null while one is active and for the default topic;
    - `runSuggest(deps, job, now)`;
    - `createTopic(db, { context } & BatchParams, now): string`;
    - `retrySuggest(db, topicId, now)`;
    - `listTopics(db): TopicListRow[]`, where `TopicListRow = TopicRow & { cardCount; openCount; discardedCount; pendingCount; searching }`, ordered with the default topic first, then newest;
    - `topicView(db, id): TopicView | null`;
    - `updateTopic(db, id, patch)` (unchanged);
    - `topicNames` and `suspendedTopicIds` (unchanged).
    - `acceptRound`, `latestRound` and `parseRoundJob` are deleted.

```ts
export type ItemView = { id: string; answerPl: string; glossRu: string | null; kind: SuggestionKind | null; source: 'suggested' | 'manual'; level: Level | null }
export type DiscardedEntry =
  | { kind: 'item'; at: number; item: ItemView }
  | { kind: 'card'; at: number; card: CardRow }
export type BatchState = 'searching' | 'failed' | 'idle'
export type TopicView = {
  topic: TopicRow
  groups: { carded: CardRow[]; open: ItemView[]; discarded: DiscardedEntry[] }
  pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
  batch: { state: BatchState; error: string | null }
}
```

- [ ] **Step 1: Failing tests.**

In `lib/db/schema-shape.test.ts`, extend the migration list with `'005-topic-items.sql'`, then add an upgrade test from a database at 004:

```ts
  it('upgrades 004 to topic items: a default topic, every card in a topic, suggestions mapped', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql', '003-topics.sql', '004-capture-lang.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql',1),('002-generation-queue.sql',1),('003-topics.sql',1),('004-capture-lang.sql',1)`).run()
    const card = sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due, deleted_at, topic_id)
      VALUES (?, 'ru_to_pl', ?, ?, 'ready', 1, 1, 1, ?, ?)`)
    sqlite.prepare(`INSERT INTO topics (id, name, context, created_at) VALUES ('t1', 'U lekarza', 'x', 1)`).run()
    card.run('live', 'kot', 'kot', null, null)
    card.run('gone', 'pies', 'pies', 5, null)
    card.run('topical', 'katar', 'katar', null, 't1')
    sqlite.prepare(`INSERT INTO captures (id, status, created_at, card_id) VALUES ('c1', 'generated', 1, 'topical')`).run()
    const sug = sqlite.prepare(`INSERT INTO suggestions (id, topic_id, round, answer_pl, gloss_ru, kind, status, capture_id, created_at)
      VALUES (?, 't1', 1, ?, 'g', 'slowo', ?, ?, 1)`)
    sug.run('p', 'gorączka', 'proposed', null)
    sug.run('a', 'katar', 'accepted', 'c1')
    sug.run('r', 'kaszel', 'rejected', null)

    migrate(sqlite)

    expect(sqlite.prepare(`SELECT id, name, is_default FROM topics WHERE is_default = 1`).all()).toEqual([
      { id: 'default', name: 'Ogólne', is_default: 1 },
    ])
    expect(sqlite.prepare(`SELECT id, topic_id FROM cards ORDER BY id`).all()).toEqual([
      { id: 'gone', topic_id: 'default' },
      { id: 'live', topic_id: 'default' },
      { id: 'topical', topic_id: 't1' },
    ])
    expect(sqlite.prepare(`SELECT id, status, source, level, card_id, discarded_at IS NOT NULL AS d FROM topic_items ORDER BY id`).all()).toEqual([
      { id: 'a', status: 'carded', source: 'suggested', level: 'zaawansowany', card_id: 'topical', d: 0 },
      { id: 'p', status: 'open', source: 'suggested', level: 'zaawansowany', card_id: null, d: 0 },
      { id: 'r', status: 'discarded', source: 'suggested', level: 'zaawansowany', card_id: null, d: 1 },
    ])
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name = 'suggestions'`).get()).toBeUndefined()
  })
```

In `lib/topics/service.test.ts`, rewrite the helpers to use `topicItems`:
- `suggestion()` becomes `item(db, answerPl, over)`, with default status `open`, source `suggested` and level `zaawansowany`.
- Delete the `acceptRound` / `latestRound` / round-number tests.
- Keep these and adapt them to the new shapes: `enqueueSuggest` one-in-flight; `runSuggest` (exclusion list, deck filter, names an unnamed topic, the "suggester error is thrown" test); `createTopic`; `retrySuggest`; `listTopics`.

Then add:

```ts
describe('batches (spec 2026-09-19-topic-items §4.5)', () => {
  it('stores a batch as open suggested items with its level and job id', async () => {
    const { db } = createTestDb()
    topic(db)
    const jobId = enqueueSuggest(db, 't1', { count: 2, mix: 'mieszane', level: 'sredni' }, NOW)!
    await runSuggest({ db, suggester: suggester([it_('katar'), it_('kaszel')]) }, jobRow(db, jobId), NOW)
    expect(db.select().from(topicItems).all().map((i) => [i.answerPl, i.status, i.source, i.level, i.batchJobId])).toEqual([
      ['katar', 'open', 'suggested', 'sredni', jobId],
      ['kaszel', 'open', 'suggested', 'sredni', jobId],
    ])
  })

  it('passes the level to the suggester', async () => {
    const { db } = createTestDb()
    topic(db)
    const s = suggester([])
    await runSuggest({ db, suggester: s }, jobRow(db, enqueueSuggest(db, 't1', { count: 10, mix: 'slowa', level: 'sredni' }, NOW)!), NOW)
    expect(s.suggest).toHaveBeenCalledWith(expect.objectContaining({ level: 'sredni', words: 15, phrases: 0 }))
  })

  it('excludes everything the topic ever held, in any status', async () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'a', { status: 'open' })
    item(db, 'b', { status: 'discarded' })
    item(db, 'c', { status: 'carded' })
    const s = suggester([it_('a'), it_('b'), it_('c'), it_('d')])
    await runSuggest({ db, suggester: s }, jobRow(db, enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)!), NOW)
    expect(s.suggest).toHaveBeenCalledWith(expect.objectContaining({ exclude: ['a', 'b', 'c'] }))
    expect(db.select().from(topicItems).where(eq(topicItems.status, 'open')).all().map((i) => i.answerPl)).toEqual(['a', 'd'])
  })

  it('does nothing when rerun after its batch was stored', async () => {
    const { db } = createTestDb()
    topic(db)
    const job = jobRow(db, enqueueSuggest(db, 't1', { count: 5, mix: 'mieszane', level: 'zaawansowany' }, NOW)!)
    await runSuggest({ db, suggester: suggester([it_('a')]) }, job, NOW)
    const s = suggester([it_('b')])
    await runSuggest({ db, suggester: s }, job, NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })

  it('never queues a batch for the default topic', () => {
    const { db } = createTestDb()
    expect(enqueueSuggest(db, DEFAULT_TOPIC_ID, { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)).toBeNull()
  })
})

describe('topicView groups (§3.3)', () => {
  it('splits a topic into carded, open and discarded', () => {
    const { db } = createTestDb()
    topic(db)
    const live = card(db, 'kot'); db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, live)).run()
    const gone = card(db, 'pies'); db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, gone)).run()
    deleteCard(db, gone, new Date(NOW.getTime() + 10))
    item(db, 'katar', { status: 'open' })
    item(db, 'kaszel', { status: 'discarded', discardedAt: NOW.getTime() + 5 })
    item(db, 'x', { status: 'carded' })
    const v = topicView(db, 't1')!
    expect(v.groups.carded.map((c) => c.answerPl)).toEqual(['kot'])
    expect(v.groups.open.map((i) => i.answerPl)).toEqual(['katar'])
    expect(v.groups.discarded.map((d) => (d.kind === 'card' ? d.card.answerPl : d.item.answerPl))).toEqual(['pies', 'kaszel'])
  })
})

describe('listTopics', () => {
  it('lists the default topic first with all three counts', () => {
    const { db } = createTestDb()
    topic(db, 't1', { createdAt: NOW.getTime() + 1 })
    item(db, 'a', { status: 'open' })
    item(db, 'b', { status: 'discarded' })
    card(db, 'kot') // lands in the default topic
    const rows = listTopics(db)
    expect(rows[0]).toMatchObject({ id: DEFAULT_TOPIC_ID, cardCount: 1, openCount: 0, discardedCount: 0 })
    expect(rows[1]).toMatchObject({ id: 't1', cardCount: 0, openCount: 1, discardedCount: 1 })
  })
})
```

In `lib/cards/service.test.ts`, add a test that `createCard` without `topicId` files the card under `'default'`, and with `topicId` uses it.

In `lib/capture/pipeline.test.ts`, add:
- a `+ karta`-style capture, created by inserting a `topic_items` row with `capture_id` and a matching queued capture: after `generateNewCard`, the item's `card_id` is the new card; after `giveUpNewCard`, the item links to the `needs_input` card;
- a topic capture with no gloss (a hand-added item) sends `{ glossRu: null, context }`;
- a capture in the default topic with no gloss is called with the transcript alone.

Run `npx vitest run lib` and confirm the failures are the missing migration, table and functions.

- [ ] **Step 2: Migration.** Create `migrations/005-topic-items.sql`:

```sql
-- Topic items (docs/superpowers/specs/2026-09-19-topic-items-design.md §3).
-- Append-only: the deployed database holds real cards.

-- The default topic. Every card belongs to a topic from now on; dictations
-- from /dodaj and hand-typed cards land here. It cannot be generated for.
ALTER TABLE topics ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
INSERT INTO topics (id, name, context, suspended_at, created_at, is_default)
VALUES ('default', 'Ogólne', '', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 1);
UPDATE cards SET topic_id = 'default' WHERE topic_id IS NULL;

-- Everything in a topic that is not a live card: suggestions, hand-added
-- items, discarded ones, and converted ones kept so a batch never repeats
-- them. Rebuilt rather than altered: SQLite cannot drop NOT NULL from
-- suggestions.gloss_ru.
CREATE TABLE topic_items (
  id            TEXT PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(id),
  answer_pl     TEXT NOT NULL,
  gloss_ru      TEXT,
  kind          TEXT,              -- 'slowo' | 'fraza' | NULL (hand-added)
  source        TEXT NOT NULL,     -- 'suggested' | 'manual'
  level         TEXT,              -- 'zaawansowany' | 'sredni' | NULL (hand-added)
  status        TEXT NOT NULL,     -- 'open' | 'discarded' | 'carded'
  capture_id    TEXT REFERENCES captures(id) ON DELETE SET NULL,
  card_id       TEXT REFERENCES cards(id),
  batch_job_id  TEXT,              -- the suggest job that proposed it
  discarded_at  INTEGER,
  created_at    INTEGER NOT NULL
);

INSERT INTO topic_items (id, topic_id, answer_pl, gloss_ru, kind, source, level, status,
                         capture_id, card_id, batch_job_id, discarded_at, created_at)
SELECT s.id, s.topic_id, s.answer_pl, s.gloss_ru, s.kind, 'suggested', 'zaawansowany',
       CASE s.status WHEN 'proposed' THEN 'open' WHEN 'rejected' THEN 'discarded' ELSE 'carded' END,
       s.capture_id, c.card_id, NULL,
       CASE s.status WHEN 'rejected' THEN s.created_at END,
       s.created_at
  FROM suggestions s LEFT JOIN captures c ON c.id = s.capture_id;

DROP TABLE suggestions;

CREATE INDEX topic_items_topic_status ON topic_items(topic_id, status);
CREATE INDEX topic_items_capture ON topic_items(capture_id);
```

- [ ] **Step 3: Schema and the default topic.**
  - `lib/topics/default.ts` exports `DEFAULT_TOPIC_ID = 'default'` with a doc comment citing spec §3.2.
  - In `lib/db/schema.ts`, remove `suggestions` and add `topicItems` with the columns above: enums for `kind` (`SUGGESTION_KINDS`), `source`, `level` (`LEVELS`) and `status`. `topics` gains `isDefault: integer('is_default', { mode: 'boolean' }).notNull()`.
  - `lib/cards/service.ts` `createCard`: `topicId: input.topicId ?? DEFAULT_TOPIC_ID`. Update the `CreateCardInput.topicId` comment: a card without a topic is filed under Ogólne.
  - Fix every test that expected `topicId: null` on a new card; it is now `'default'`. Test fixtures that insert `topics` rows directly need `isDefault: false`.

- [ ] **Step 4: The pipeline.** In `lib/capture/pipeline.ts`:

```ts
/** A topic item's intended sense and situation; undefined when there is neither (spec 2026-09-19-topic-items §4.1). */
function meaningOf(db: Db, capture: { topicId: string | null; glossRu: string | null }): Meaning | undefined {
  if (!capture.topicId) return undefined
  const topic = db.select({ context: topics.context }).from(topics).where(eq(topics.id, capture.topicId)).get()
  const context = topic?.context.trim() ? topic.context : null
  const glossRu = capture.glossRu?.trim() ? capture.glossRu : null
  return glossRu || context ? { glossRu, context } : undefined
}
```

After the card is known in `generateNewCard` and in `giveUpNewCard`, link the item:

```ts
  // A `+ karta` item (spec 2026-09-19-topic-items §4.1) learns which card it became.
  db.update(topicItems).set({ cardId }).where(eq(topicItems.captureId, captureId)).run()
```

- [ ] **Step 5: The service port.** Rewrite the storage half of `lib/topics/service.ts` to the interfaces above:
  - **Imports:** `topicItems`, `LEVELS`, `pickBatch`, `DEFAULT_TOPIC_ID`.
  - **`BatchJob` schema:** `z.object({ count: z.number().int().positive(), mix: z.enum(MIXES), level: z.enum(LEVELS) })`.
  - **`enqueueSuggest`:** returns null if `topicId === DEFAULT_TOPIC_ID` or a job is active. Otherwise it enqueues with `paramsJson: JSON.stringify(params)`.
  - **`runSuggest`:**
    - returns if the topic is missing, or if `topicItems` already has a row with `batchJobId = job.id`;
    - builds `history` from every `topicItems.answerPl` of the topic, oldest first (`createdAt`, then `rowid`);
    - calls `suggest` with `level`;
    - runs `pickBatch(result.items, taken, count, mix)`;
    - in one transaction, rechecks the job-id guard, sets the name if it is still null, and inserts each item as `{ status: 'open', source: 'suggested', level, batchJobId: job.id, discardedAt: null, captureId: null, cardId: null }`.
  - **`createTopic`:** takes `level`. The insert sets `isDefault: false`.
  - **`retrySuggest`:** re-enqueues the failed job's `parseBatchJob` params.
  - **`listTopics`:** add `openCount` (items `open`) and `discardedCount` (items `discarded` plus soft-deleted cards) per topic, and order by `desc(topics.isDefault)` then `desc(topics.createdAt)`.
  - **`topicView`:** as specified in the Interfaces above.
    - `carded`: live cards of the topic, newest first.
    - `open`: open items, oldest first, so a batch reads in the model's order.
    - `discarded`: discarded items (`at = discardedAt ?? createdAt`) merged with deleted cards (`at = deletedAt`), newest first.
    - `batch.state`: `searching` if a job is active, `failed` if the latest job failed (with its error), otherwise `idle`.
  - **Removed:** `acceptRound`, `latestRound`, `roundExists` and `parseRoundJob`.
  - **Doc comment:** the file comment now describes topics, items and batches.
  - **Routes:** `git rm "app/api/topics/[id]/rounds/[round]/route.ts"` and delete its tests in `app/api/topics/route.test.ts`. `POST /api/topics` accepts `level` through `lib/topics/body.ts`, where `RoundBody` becomes `BatchBody` with `level: z.enum(LEVELS)`. The `GET /api/topics/:id` route just returns the new `topicView`. Update its route test to the new shape.

- [ ] **Step 6: Run the tests.** `npx vitest run lib app/api` should pass and `npx tsc --noEmit` should be clean. The topic pages' DOM tests mock `fetch`, so they stay green until Task 6.
- [ ] **Step 7: Gates, then commit.**

```bash
git add -A migrations lib app/api
git commit -m "feat: migration 005 — topic items and a default topic; batches replace rounds"
```

---

### Task 3: Item and card actions

**Files:**
- Modify: `lib/topics/service.ts`, `lib/topics/service.test.ts`, `lib/cards/service.ts`, `lib/cards/service.test.ts`, `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`

**Interfaces:**
- Produces, in `lib/cards/service.ts`:
  - `knownCardFor(db, text): string | null`, moved verbatim from `lib/capture/pipeline.ts`, which now imports it from here;
  - `restoreCard(db, id, now): { ok: true; card: CardRow } | { ok: false; reason: 'not-found' } | { ok: false; reason: 'conflict'; topicName: string }`;
  - `moveCard(db, id, topicId): CardRow | null`, which returns null for an unknown card or topic.
- Produces, in `lib/topics/service.ts`:
  - `cardItem(db, topicId, itemId, now): { captureId: string } | null` — null when the item isn't in this topic or isn't open;
  - `discardItem(db, topicId, itemId, now): boolean`;
  - `restoreItem(db, topicId, itemId): boolean`;
  - `moveItem(db, itemId, toTopicId): boolean`;
  - `addManualItem(db, topicId, text, now)`, which returns one of `{ ok: true; item: ItemView } | { ok: false; reason: 'empty' | 'not-found' } | { ok: false; reason: 'in-topic' } | { ok: false; reason: 'in-deck'; topicName: string }`.

- [ ] **Step 1: Failing tests.** In `lib/topics/service.test.ts`, with the Task 2 helpers:

```ts
describe('+ karta (§4.1)', () => {
  it('turns an open item into a queued capture with a new job, and marks it carded', () => {
    const { db } = createTestDb()
    topic(db)
    const id = item(db, 'gorączka', { glossRu: 'жар' })
    const { captureId } = cardItem(db, 't1', id, NOW)!
    expect(db.select().from(captures).where(eq(captures.id, captureId)).get()).toMatchObject({
      status: 'queued', audioMediaId: null, transcript: 'gorączka', topicId: 't1', glossRu: 'жар',
    })
    expect(db.select().from(generationJobs).where(eq(generationJobs.captureId, captureId)).get()!.kind).toBe('new')
    expect(db.select().from(topicItems).where(eq(topicItems.id, id)).get()).toMatchObject({ status: 'carded', captureId })
  })

  it('refuses an item that is not open, or not in this topic', () => {
    const { db } = createTestDb()
    topic(db); topic(db, 't2')
    const gone = item(db, 'a', { status: 'discarded' })
    expect(cardItem(db, 't1', gone, NOW)).toBeNull()
    expect(cardItem(db, 't2', item(db, 'b'), NOW)).toBeNull()
  })
})

describe('discard and restore (§4.2, §4.3)', () => {
  it('discards an item with a timestamp and restores it to open', () => {
    const { db } = createTestDb()
    topic(db)
    const id = item(db, 'a')
    expect(discardItem(db, 't1', id, NOW)).toBe(true)
    expect(db.select().from(topicItems).get()).toMatchObject({ status: 'discarded', discardedAt: NOW.getTime() })
    expect(restoreItem(db, 't1', id)).toBe(true)
    expect(db.select().from(topicItems).get()).toMatchObject({ status: 'open', discardedAt: null })
  })
})

describe('adding by hand (§4.6)', () => {
  it('saves a trimmed manual open item with no gloss, kind or level', () => {
    const { db } = createTestDb()
    topic(db)
    const r = addManualItem(db, 't1', '  wahacz  ', NOW)
    expect(r).toMatchObject({ ok: true, item: { answerPl: 'wahacz', glossRu: null, kind: null, source: 'manual', level: null } })
  })

  it('refuses empty text, a word the topic already holds in any status, and a deck word', () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'Katar', { status: 'discarded' })
    card(db, 'kot') // in Ogólne
    expect(addManualItem(db, 't1', '  ', NOW)).toEqual({ ok: false, reason: 'empty' })
    expect(addManualItem(db, 't1', 'katar.', NOW)).toEqual({ ok: false, reason: 'in-topic' })
    expect(addManualItem(db, 't1', 'Kot', NOW)).toEqual({ ok: false, reason: 'in-deck', topicName: 'Ogólne' })
  })

  it('matches a Cyrillic entry against cards\' Russian prompts', () => {
    const { db } = createTestDb()
    topic(db)
    card(db, 'kot') // helper's promptText is 'x'
    db.update(cards).set({ promptText: 'кот' }).run()
    expect(addManualItem(db, 't1', 'Кот', NOW)).toMatchObject({ ok: false, reason: 'in-deck' })
  })

  it('is allowed in the default topic', () => {
    const { db } = createTestDb()
    expect(addManualItem(db, DEFAULT_TOPIC_ID, 'wahacz', NOW)).toMatchObject({ ok: true })
  })
})

describe('moving (§4.4)', () => {
  it('moves an item to another topic without changing its status', () => {
    const { db } = createTestDb()
    topic(db); topic(db, 't2')
    const id = item(db, 'a', { status: 'discarded' })
    expect(moveItem(db, id, 't2')).toBe(true)
    expect(db.select().from(topicItems).get()).toMatchObject({ topicId: 't2', status: 'discarded' })
    expect(moveItem(db, id, 'nope')).toBe(false)
  })
})
```

In `lib/cards/service.test.ts` (`input()` stands for that file's existing card-input helper — use whatever it is called there):

```ts
describe('restoreCard', () => {
  it('undeletes a card with its schedule untouched', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    db.update(cards).set({ reps: 3, stability: 7 }).where(eq(cards.id, cardId)).run()
    deleteCard(db, cardId, NOW)
    const r = restoreCard(db, cardId, NOW)
    expect(r).toMatchObject({ ok: true, card: { id: cardId, deletedAt: null, reps: 3, stability: 7 } })
  })

  it('refuses when a live card with the same answer now exists, naming its topic', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    deleteCard(db, cardId, NOW)
    createCard(db, input(), NOW) // a fresh one, filed under Ogólne
    expect(restoreCard(db, cardId, NOW)).toEqual({ ok: false, reason: 'conflict', topicName: 'Ogólne' })
  })
})

describe('moveCard', () => {
  it('moves a card to another topic, refusing an unknown one', () => {
    const { db } = createTestDb()
    db.insert(topics).values({ id: 't2', name: 'B', context: 'x', suspendedAt: null, createdAt: 1, isDefault: false }).run()
    const { cardId } = createCard(db, input(), NOW)
    expect(moveCard(db, cardId, 't2')!.topicId).toBe('t2')
    expect(moveCard(db, cardId, 'nope')).toBeNull()
  })
})
```

Run `npx vitest run lib/topics lib/cards` and confirm the functions are missing.

- [ ] **Step 2: Implement.**
  - **`knownCardFor`:** move it with its `CYRILLIC` constant and doc comment into `lib/cards/service.ts`, export it, and import it in `lib/capture/pipeline.ts`. Its behaviour is unchanged, and existing pipeline tests keep passing.
  - **`restoreCard`:**
    1. Read the card. If it is missing or not deleted, return `not-found`.
    2. Check `findDuplicate(db, { type: card.type, answerPl: card.answerPl })`. If it finds a live card, return `conflict` with that card's topic name (`topics.name ?? ''`).
    3. Otherwise set `deletedAt: null, updatedAt: now` and return the card.
  - **`moveCard`:** return null unless both the live card and the topic exist, then set `topicId` and `updatedAt`.
  - **`cardItem`:** in one transaction, read the item and require `topicId` to match and `status` to be `open`. Then insert a capture with the same values `acceptRound` used (`audioMediaId: null`, `transcript: answerPl`, `status: 'queued'`, `topicId`, `glossRu`, `lang: null`), `enqueueJob(t, { kind: 'new', captureId }, now)`, and set the item `{ status: 'carded', captureId }`.
  - **`discardItem`:** only an `open` item of this topic becomes `{ status: 'discarded', discardedAt: now }`.
  - **`restoreItem`:** only a `discarded` item becomes `{ status: 'open', discardedAt: null }`.
  - **`moveItem`:** check the target topic exists, then set `topicId`.
  - **`addManualItem`:**
    1. `trim`; if empty, return `empty`. If the topic is missing, return `not-found`.
    2. `key = answerKey(text)`. If any topic item has the same key in any status (compare keys in JS, like `searchCards`), return `in-topic`.
    3. `knownCardFor(db, text)`. If it finds a card, return `in-deck` with that card's topic name.
    4. Otherwise insert `{ source: 'manual', status: 'open', glossRu: null, kind: null, level: null, batchJobId: null, ... }` and return its `ItemView`.
- [ ] **Step 3: Run the tests.** `npx vitest run lib` should pass.
- [ ] **Step 4: Gates, then commit.**

```bash
git commit -am "feat: item and card actions — + karta, discard, restore, move, add by hand"
```

---

### Task 4: Endpoints

**Files:**
- Create:
  - `app/api/topics/[id]/batches/route.ts`
  - `app/api/topics/[id]/items/route.ts`
  - `app/api/topics/[id]/items/[itemId]/route.ts`
  - `app/api/topics/[id]/items/[itemId]/card/route.ts`
  - `app/api/topics/[id]/items/[itemId]/discard/route.ts`
  - `app/api/topics/[id]/items/[itemId]/restore/route.ts`
  - `app/api/cards/[id]/restore/route.ts`
  - `app/api/topics/items.route.test.ts`
- Modify: `app/api/topics/[id]/route.ts`, `app/api/cards/[id]/route.ts`, `app/api/cards/[id]/route.test.ts`, `app/api/topics/route.test.ts`

**Interfaces (all JSON):**

| route | success | errors |
|---|---|---|
| `POST /api/topics/:id/batches` `{count,mix,level}` | 202 `{ jobId }` (`jobId` null while one is running) | 400 bad body or the default topic; 404 unknown topic |
| `PATCH /api/topics/:id` | as before | 400 on `name` or `context` for the default topic |
| `POST /api/topics/:id/items` `{ text }` | 201 `{ item }` | 400 `{error}` empty; 404; 409 `{ error: 'już jest w tym temacie' }` or `{ error: 'już masz — w temacie <name>' }` |
| `POST /api/topics/:id/items/:itemId/card` | 202 `{ captureId }` | 404 |
| `POST …/discard`, `POST …/restore` | `{ ok: true }` | 404 |
| `PATCH /api/topics/:id/items/:itemId` `{ topicId }` | `{ ok: true }` | 400 bad body; 404 |
| `POST /api/cards/:id/restore` | `{ card }` | 404; 409 `{ error: 'już masz — w temacie <name>' }` |
| `PATCH /api/cards/:id` | gains optional `topicId` → `moveCard` | 404 unknown topic |

- [ ] **Step 1: Failing tests.**
  - Create `app/api/topics/items.route.test.ts` in the style of `app/api/topics/route.test.ts`: a `FISZKI_DB` temp file, dynamic imports, and a `beforeEach` that deletes `topicItems`, `generationJobs`, `captures`, `cards`, then non-default `topics`.
  - Cover every row of the table above: each success shape, and each error code with its exact Polish text.
  - Include a batch refused for `'default'` with 400, and a rename of `'default'` refused with 400.
  - In `app/api/cards/[id]/route.test.ts`, add PATCH `topicId` (a move, then a 404 for an unknown topic) and the restore route (success, then a 409 with the text).
- [ ] **Step 2: Implement** each route as a thin wrapper over the Task 2–3 functions:
  - Validate with zod. `BatchBody` lives in `lib/topics/body.ts`; `{ text: z.string() }` and `{ topicId: z.string().min(1) }` go inline.
  - The route turns the service's reasons into the codes and texts above.
  - Only the batches route checks `id === DEFAULT_TOPIC_ID` for its 400.
  - Import `DEFAULT_TOPIC_ID` from `@/lib/topics/default`. Never export anything but handlers from a `route.ts`.
- [ ] **Step 3: Run the tests.** `npx vitest run app/api` should pass.
- [ ] **Step 4: Gates (the build matters), then commit.**

```bash
git add -A app/api lib/topics/body.ts
git commit -m "feat: endpoints for topic items, batches, and moving and restoring cards"
```

---

### Task 5: Building blocks — batch settings, move picker, hand-add bar, card row actions

**Files:**
- Create: `components/BatchSettings.tsx` and its test (replaces `components/RoundSettings.tsx` and its test, which are deleted); `components/MoveToTopic.tsx` and its test; `components/ManualAddBar.tsx` and its test
- Modify: `components/CardListItem.tsx` and its test, `i18n/pl.ts`, `i18n/pl.test.ts`

**Interfaces:**
- `<BatchSettings value={BatchParams} onChange={(p: BatchParams) => void} />`: a count select (label `t.roundCount`), a mix switch (`mieszane · tylko słowa · tylko frazy`), and a level switch (`zaawansowany · średniozaawansowany`). Each switch button has `aria-pressed`.
- `<MoveToTopic currentTopicId={string} onMove={(topicId: string) => Promise<void> | void} />`:
  - A button reads `${t.moveTo}: …`.
  - Tapping it fetches `GET /api/topics` and lists the other topics as buttons with their names (`t.unnamedTopic` if null).
  - Choosing one calls `onMove(id)` and closes the list.
  - If the fetch fails, it shows `t.topicSaveFailed`.
- `<ManualAddBar onAdd={(text: string) => Promise<string | null>} />`:
  - It holds a text field (`aria-label={t.manualAdd}`, placeholder `t.manualPlaceholder`) and PL/RU hold buttons (`aria-label={t.recordPolish}` / `{t.recordRussian}`).
  - A recording is posted to `/api/topics/transcribe` with `lang`, and the transcript replaces the field's text.
  - **dodaj** (disabled when the text is empty) calls `onAdd(text.trim())`. It resolves to an error message, which is shown, or null, which clears the field. **anuluj** clears the field and any message.
  - A denied microphone shows `t.micDenied`, and the field keeps working. A failed transcription shows `t.transcribeFailed`.
- `CardListItem` gains an optional `actions?: ReactNode`, rendered in its own `<div>` beside the `Link` (not inside it), so buttons don't navigate.
- **Strings:**
  - Change `mixWords: 'tylko słowa'`, `mixPhrases: 'tylko frazy'`.
  - Add `levelAdvanced: 'zaawansowany'`, `levelIntermediate: 'średniozaawansowany'`, `levelBadge: 'śr.'`, `tabCarded: 'z kartą'`, `tabOpen: 'bez karty'`, `tabDiscarded: 'odrzucone'`, `makeCard: '+ karta'`, `discard: 'odrzuć'`, `restore: 'przywróć'`, `cardBadge: 'karta'`, `moveTo: 'temat'`, `manualAdd: 'dodaj słowo lub frazę'`, `manualPlaceholder: 'wpisz albo nagraj…'`, `add: 'dodaj'`, `cancel: 'anuluj'`, `moveToDiscarded: 'przenieś do odrzuconych'`.
  - Remove `acceptAndMore` and `acceptAndFinish`, and update `i18n/pl.test.ts`'s `required` list.

- [ ] **Step 1: Failing tests.** Write DOM tests for each component, following `components/RoundSettings.dom.test.tsx` and `app/tematy/nowy/page.dom.test.tsx`:
  - **BatchSettings:** the three mixes and two levels, `aria-pressed`, and `onChange` payloads.
  - **MoveToTopic:** it lists every topic except the current one, calls `onMove` with the chosen id, and shows an error on a failed fetch.
  - **ManualAddBar:**
    - typing and **dodaj** calls `onAdd` with trimmed text and clears on null;
    - an error string from `onAdd` is shown and the text kept;
    - **anuluj** clears;
    - holding RU posts `lang=ru` and fills the field with the transcript. Reuse the `FakeMediaRecorder` pattern from `app/dodaj/page.dom.test.tsx`;
    - a rejected `getUserMedia` shows `t.micDenied`.
  - **CardListItem:** `actions` render outside the link.
- [ ] **Step 2: Implement** the components. Reuse the recording wiring from `app/tematy/nowy/page.tsx` in `ManualAddBar`: `mediaRecorderFactory`, one stream, two `useHoldToRecord` instances. Delete `components/RoundSettings.tsx` and its test, and point importers to `BatchSettings`.
- [ ] **Step 3: Run the tests.** `npx vitest run components i18n app/tematy` should pass.
- [ ] **Step 4: Gates, then commit.**

```bash
git add -A components i18n app/tematy
git commit -m "feat: batch settings with level, a move picker, a hand-add bar, card row actions"
```

---

### Task 6: The topic page

**Files:**
- Modify: `app/tematy/[id]/page.tsx` (rewrite), `app/tematy/[id]/page.dom.test.tsx` (rewrite)

**Behaviour (spec §5.2):**
- **Loading:** it loads `GET /api/topics/:id` and keeps the Task 10/11 error handling. Only a 404 shows `t.topicNotFound`; other failures keep the last view and show `t.topicsLoadFailed`. The first load and polling never produce an unhandled rejection.
- **Polling:** every 2 s while `batch.state === 'searching'` or `pending.length > 0`.
- **Header:**
  - The name input is disabled for the default topic.
  - The `<details>` context editor is absent for the default topic.
  - The on/off switch stays.
- **Tabs:** `${t.tabCarded} (n) · ${t.tabOpen} (n) · ${t.tabDiscarded} (n)`, as buttons with `aria-pressed`, where the carded count includes pending.
  - The chosen tab is stored in `localStorage['fiszki:tab:' + id]`, wrapped in try/catch.
  - With nothing stored, it opens on **bez karty** if `open.length > 0`, otherwise **z kartą**.
- **z kartą:**
  - Pending rows come first (transcript plus `t.queued` / `t.generating`).
  - Then a `CardListItem` per card, with `actions` of a `✕` button (`aria-label={t.discard}`, which calls `DELETE /api/cards/:id`) and `MoveToTopic` (`PATCH /api/cards/:id { topicId }`).
- **bez karty:**
  - `ManualAddBar` comes first. Its `onAdd` posts to `/api/topics/:id/items`, returns the `error` of a 400 or 409 response or null on 201, then reloads.
  - Each item row shows `answerPl`; ` — glossRu` when present; the kind marker (`t.kindWord` / `t.kindPhrase`) when present; `t.levelBadge` when `level === 'sredni'`.
  - Each row has `+ karta` (`POST …/card`), `✕` (`POST …/discard`, `aria-label={t.discard}`) and `MoveToTopic` (`PATCH …/items/:itemId`).
  - At the bottom, unless the topic is the default:
    - `BatchSettings` (state initialised to `{ count: DEFAULT_COUNT, mix: 'mieszane', level: 'zaawansowany' }`) and **jeszcze** (`POST /api/topics/:id/batches`);
    - `t.searching` while searching;
    - on failure, the error with `t.tryAgain` (`POST /api/topics/:id/retry`).
- **odrzucone:** each entry shows its text and a `t.restore` button. An item calls `POST …/items/:itemId/restore`; a card shows `t.cardBadge` and calls `POST /api/cards/:id/restore`, and a 409 shows its `error`.
- **Every action** sets a busy flag, disables the buttons of that row while in flight, reloads afterwards, and shows `t.topicSaveFailed` (or the server's `error`) on failure. The list stays as it was.

- [ ] **Step 1: Failing tests.** Rewrite `app/tematy/[id]/page.dom.test.tsx` with a `view()` fixture of the new shape and a URL- and method-aware fetch stub. Cover:
  - the tab counts;
  - the initial tab rule, and the stored tab;
  - **z kartą** rows with ✕ calling `DELETE /api/cards/k1`;
  - an item's `+ karta` posting to `…/items/i1/card`;
  - ✕ posting `…/discard`;
  - a manual add posting `{ text }`, and a 409 message shown;
  - restore for an item and a card, and a card 409 message shown;
  - the move picker posting the right PATCH;
  - no batch controls and a disabled name input for `topic.isDefault`;
  - a batch posting `{ count, mix, level }`;
  - searching and failed states;
  - a 404 showing `t.topicNotFound`;
  - a 500 keeping the page and showing `t.topicsLoadFailed`.
- [ ] **Step 2: Implement** the page per the behaviour above. Keep it under ~350 lines by composing the Task 5 components. If it grows past that, split the three tab bodies into `app/tematy/[id]/` sibling components and say so in the report.
- [ ] **Step 3: Run the tests.** `npx vitest run app/tematy components` should pass.
- [ ] **Step 4: Gates, then commit.**

```bash
git add -A app/tematy
git commit -m "feat: the topic page — three groups, hand-added items, per-item actions"
```

---

### Task 7: Topic list, new topic, card page

**Files:**
- Modify: `app/tematy/page.tsx`, `app/tematy/page.dom.test.tsx`, `app/tematy/nowy/page.tsx`, `app/tematy/nowy/page.dom.test.tsx`, `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`

**Behaviour:**
- **`/tematy`:**
  - Rows show `cardCount`, `openCount` and `discardedCount` (for example `12 · 5 · 3`, with a `title` naming the three groups), plus `+n w kolejce` and the switch.
  - The list is already ordered with the default topic first, so the page doesn't sort.
  - Polling is unchanged.
- **`/tematy/nowy`:** `BatchSettings` replaces `RoundSettings`, and the POST body carries `level`.
- **`/fiszki/[id]`:**
  - The topic link becomes `MoveToTopic` (`PATCH /api/cards/:id { topicId }`), and the page reloads after a move.
  - The delete button's label becomes `t.moveToDiscarded`. The behaviour is the same `DELETE`, then `router.push('/fiszki')`.
  - Update the comments that said the card is deleted: it moves to its topic's **odrzucone**.

- [ ] **Step 1: Failing tests** for each behaviour above, in the existing test files' style.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the tests.** `npx vitest run app` should pass.
- [ ] **Step 4: Gates, then commit.**

```bash
git add -A app
git commit -m "feat: topic list counts, level on a new topic, moving and discarding from the card page"
```

---

### Task 8: Live probe (and the controller's run)

**Files:**
- Modify: `scripts/try-suggestions.ts`

- [ ] **Step 1:** Change the usage to `npx tsx --env-file=.env.local scripts/try-suggestions.ts [count] [mix] [level]`, validate `level` against `LEVELS` (default `zaawansowany`), pass it to `suggest`, and apply `pickBatch(items, new Set(), count, mix)` before printing. That way `slowa`/`frazy` show what would actually be stored. Print `[level]` in each section header.
- [ ] **Step 2:** Gates, then commit (`chore: probe suggestions by level and mix`).
- [ ] **Step 3 (controller):**
  - Run `10 mieszane zaawansowany`, `10 mieszane sredni`, `10 slowa sredni` and `10 frazy zaawansowany`, retrying on 429.
  - Check: intermediate batches are visibly more everyday than advanced ones; `slowa`/`frazy` contain only their kind after filtering; no English.
  - Show the user.

---

### Task 9: Deploy and verify (controller-only, with the user's go-ahead)

- [ ] **Step 1:** Gates on the finished branch.
- [ ] **Step 2:** Back up (`fiszki-backup.service`) and confirm the upload.
- [ ] **Step 3:** Do a fresh-tree swap, detached. First confirm the new tree has `migrations/005-topic-items.sql` and no `app/api/topics/[id]/rounds`.
- [ ] **Step 4:** Verify:
  - `_migrations` lists 005;
  - exactly one `is_default = 1` topic;
  - `select count(*) from cards where topic_id is null` is 0;
  - the card count is unchanged;
  - the count of `topic_items` equals the old `suggestions` count recorded before the deploy;
  - the pages return 200;
  - `check-providers` passes.
- [ ] **Step 5:** Ask the user to check on the phone: hand-add a dictated item and make it a card; discard and restore a card (its review history kept); move a card from Ogólne to another topic; generate an intermediate "only phrases" batch.
