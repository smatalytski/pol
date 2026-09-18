# Generation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Gemini call runs from a persistent queue with 429 backoff; a recognised recording gets a 10-second review window before it is approved and queued; the recording screen shows only recent recordings and their status.

**Architecture:** A `generation_jobs` table plus a worker started from `instrumentation.ts` inside the Next.js server. Pure modules decide approval (`lib/queue/review.ts`) and backoff (`lib/queue/backoff.ts`); `lib/queue/jobs.ts` stores and runs jobs through injected handlers; `lib/capture/pipeline.ts` is split into a synchronous recognition half (`recognizeCapture`, `rerecognize`) and queued generation handlers (`generateNewCard`, `applyRerecognized`, plus `regenerateCard`).

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, SQLite (better-sqlite3) + Drizzle, hand-written SQL migrations, Vitest + jsdom, Gemini on Vertex (`@google/genai`), Google Speech-to-Text v2.

**Spec:** `docs/superpowers/specs/2026-09-18-generation-queue-design.md` — read it before any task. Where this plan and the spec disagree, the spec wins; stop and report. Two deliberate refinements: the list endpoint returns `reviewRemainingMs` (server-computed) rather than an absolute `reviewEndsAt`, so the phone's clock skew can't distort the bar (Task 5); and the spec's per-capture `isApproved(capture, underReview, now)` is implemented as `approvedIds(underReview, now)`, which answers it for every recording at once (Task 3). Both routes and the worker share it, as the spec requires.

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, `npm run build` exits 0. Vitest does not typecheck. Read each gate's output before committing; never chain a commit after a test command with `&&`.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed. A test that cannot fail if the behaviour is removed is a defect — say so if one passes before your change.
- **Every comment must be true when committed**, including comments your change makes false in files you touch.
- **Migrations are append-only.** This plan adds exactly one, `migrations/002-generation-queue.sql`. Never edit `001-init.sql`. The deployed database holds real cards.
- **Clock and randomness are injected:** every stateful function takes `now: Date`; backoff takes `random: () => number`.
- **After this plan no HTTP handler calls Gemini.** Speech-to-Text stays synchronous in requests; every `fromDictation` call happens in a queue job.
- **Exact values:** `REVIEW_MS = 10_000`, `MAX_IN_REVIEW = 5`, backoff base `5_000` ms, cap `300_000` ms, equal jitter `d/2 + random()*d/2`; `MAX_ATTEMPTS_NON_RETRYABLE = 3`; retryable HTTP statuses `429, 500, 503` plus network errors; worker tick `1_000` ms.
- **Capture statuses:** `uploaded | transcribed | queued | generating | generated | duplicate | failed`. `failed` means recognition failed, never generation.
- **Job kinds:** `new | regenerate | rerecognized`. **Job statuses:** `queued | running | done | failed`.
- **All UI strings live in `i18n/pl.ts`, in Polish.**
- **Do not change `FISZKI_MODEL`.**
- The `app/dodaj/page.dom.test.tsx` polling tests are intermittently flaky. Make new UI tests data-driven, not timer-driven, and run that file 5 times after changing it; report how many runs were fully green.

## File map

| File | Responsibility | Task |
|---|---|---|
| `migrations/002-generation-queue.sql` (new) | new columns, `generation_jobs`, backfill | 1 |
| `lib/db/schema.ts` | Drizzle mirror | 1 |
| `lib/generate/index.ts` | `GenerationError.retryable`, `isRetryableRequestError` | 2 |
| `lib/queue/review.ts` (new) | pure approval rule and remaining time | 3 |
| `lib/queue/backoff.ts` (new) | pure backoff | 3 |
| `lib/queue/jobs.ts` (new) | job store, promotion, recovery, `runNextJob` | 4 |
| `lib/capture/pipeline.ts` | recognition half, job handlers, on-screen list, pending list | 5 |
| `lib/queue/worker.ts`, `instrumentation.ts` (new) | the loop and its start | 6 |
| `app/api/cards/**` routes | queued regeneration, pending data | 7 |
| `components/CaptureChip.tsx`, `app/dodaj/page.tsx` | the recording screen | 8 |
| `app/fiszki/page.tsx` | pending rows | 9 |
| `app/fiszki/[id]/page.tsx` | queued actions, `generowanie…` | 10 |

---

### Task 1: Migration 002 and schema

**Files:**
- Create: `migrations/002-generation-queue.sql`
- Modify: `lib/db/schema.ts`, `lib/db/schema-shape.test.ts`

**Interfaces:**
- Produces: `captures.transcribedAt: number | null`, `captures.duplicateOf: string | null`, capture status enum as in Global Constraints; `generationJobs` Drizzle table with fields `id, kind, captureId, cardId, status, attempts, nextAttemptAt, lastError, createdAt, finishedAt`.

- [ ] **Step 1: Write the failing tests**

In `lib/db/schema-shape.test.ts`, replace the test `'is a single squashed migration'` with:

```ts
  // The squash of 2026-09-18 happened once; everything after it appends.
  it('applies the squashed base and then the appended migrations, in order', () => {
    const { sqlite } = createTestDb()
    const names = (sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(['001-init.sql', '002-generation-queue.sql'])
  })
```

and add:

```ts
  it('gives captures a review timestamp and a recognition-time duplicate', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['transcribed_at', 'duplicate_of']))
  })

  it('has a generation_jobs table with the queue columns', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(generation_jobs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'id', 'kind', 'capture_id', 'card_id', 'status', 'attempts',
      'next_attempt_at', 'last_error', 'created_at', 'finished_at',
    ])
  })

  // DELETE /api/captures/:id hard-deletes a rejected recording. Its job must go
  // with it, or the foreign key refuses the delete.
  it('deletes a recording together with its jobs', () => {
    const { sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'queued', 1)`).run()
    sqlite
      .prepare(`INSERT INTO generation_jobs (id, kind, capture_id, status, next_attempt_at, created_at) VALUES ('j1', 'new', 'c1', 'queued', 1, 1)`)
      .run()
    sqlite.prepare(`DELETE FROM captures WHERE id = 'c1'`).run()
    expect(sqlite.prepare('SELECT count(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 })
  })

  // The deployed database already holds data when 002 arrives. A recording
  // caught mid-pipeline by the upgrade ('transcribed' with no review
  // timestamp) must not be stranded outside the review rule.
  it('upgrades a database that already has 001 applied, keeping its rows', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(readFileSync(join(process.cwd(), 'migrations', '001-init.sql'), 'utf8'))
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, transcript, created_at) VALUES ('old', 'generated', 'kot', 100)`).run()
    sqlite.prepare(`INSERT INTO captures (id, status, transcript, created_at) VALUES ('mid', 'transcribed', 'pies', 200)`).run()

    migrate(sqlite)

    const rows = sqlite.prepare('SELECT id, status, transcribed_at FROM captures ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'mid', status: 'transcribed', transcribed_at: 200 },
      { id: 'old', status: 'generated', transcribed_at: null },
    ])
  })
```

Add imports at the top: `import Database from 'better-sqlite3'`, `import { readFileSync } from 'node:fs'`, `import { join } from 'node:path'`, `import { migrate } from './migrate'`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/db/schema-shape.test.ts`
Expected: the migrations list is `['001-init.sql']`; `transcribed_at`, `duplicate_of` and `generation_jobs` do not exist.

- [ ] **Step 3: Write the migration**

`migrations/002-generation-queue.sql`:

```sql
-- Generation queue (docs/superpowers/specs/2026-09-18-generation-queue-design.md
-- §9). Append-only again: the one-time squash of 2026-09-18 does not repeat,
-- because the deployed database now holds real cards.

-- When the transcript arrived: the start of the 10-second review window (§3).
ALTER TABLE captures ADD COLUMN transcribed_at INTEGER;

-- The card a transcript already matches at recognition time (§4): the chip's
-- "już masz". A recording approved with this set becomes 'duplicate' and is
-- never queued.
ALTER TABLE captures ADD COLUMN duplicate_of TEXT REFERENCES cards(id);

-- A recording caught mid-pipeline by this upgrade is 'transcribed' with no
-- review timestamp. Stamping it with its upload time puts it under the review
-- rule, which approves it on the worker's first tick (it is long past 10 s).
UPDATE captures SET transcribed_at = created_at WHERE status = 'transcribed';

CREATE TABLE generation_jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,     -- 'new' | 'regenerate' | 'rerecognized'
  -- ON DELETE CASCADE: rejecting a recording hard-deletes its row, and its job
  -- goes with it.
  capture_id       TEXT REFERENCES captures(id) ON DELETE CASCADE,
  card_id          TEXT REFERENCES cards(id),
  status           TEXT NOT NULL,     -- 'queued' | 'running' | 'done' | 'failed'
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);

CREATE INDEX generation_jobs_due ON generation_jobs(status, next_attempt_at);
```

- [ ] **Step 4: Update the Drizzle schema**

In `lib/db/schema.ts`, change the `captures` table to:

```ts
export const captures = sqliteTable('captures', {
  id: text('id').primaryKey(),
  audioMediaId: text('audio_media_id'),
  transcript: text('transcript'),
  status: text('status', {
    enum: ['uploaded', 'transcribed', 'queued', 'generating', 'generated', 'duplicate', 'failed'],
  }).notNull(),
  error: text('error'),
  generationJson: text('generation_json'),
  cardId: text('card_id'),
  createdAt: integer('created_at').notNull(),
  transcribedAt: integer('transcribed_at'),
  duplicateOf: text('duplicate_of'),
})
```

and add, after `captures`:

```ts
export const generationJobs = sqliteTable('generation_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['new', 'regenerate', 'rerecognized'] }).notNull(),
  captureId: text('capture_id'),
  cardId: text('card_id'),
  status: text('status', { enum: ['queued', 'running', 'done', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
})
```

- [ ] **Step 5: Run the gates, then commit**

`npx tsc --noEmit` may flag capture fixtures built as full `$inferInsert`/`$inferSelect` rows; add `transcribedAt: null, duplicateOf: null` where it does. Then all three gates.

```bash
git add -A
git commit -m "feat: migration 002 adds the generation queue and the review timestamp

Append-only. captures gains transcribed_at and duplicate_of; generation_jobs
holds the queue, cascading with a deleted recording. A recording caught
mid-pipeline by the upgrade is stamped so the review rule approves it."
```

---

### Task 2: `GenerationError.retryable`

**Files:**
- Modify: `lib/generate/index.ts`, `lib/generate/index.test.ts`

**Interfaces:**
- Produces: `class GenerationError extends Error { readonly retryable: boolean; constructor(message: string, opts?: { retryable?: boolean }) }`; `export function isRetryableRequestError(err: unknown): boolean`.

- [ ] **Step 1: Write the failing tests**

In `lib/generate/index.test.ts`, import `isRetryableRequestError` and add:

```ts
describe('retryable generation failures', () => {
  const failWith = (err: unknown) => vi.fn().mockRejectedValue(err)
  const make429 = () => Object.assign(new Error('Resource exhausted'), { status: 429 })

  it('marks an HTTP 429 as retryable', async () => {
    const err = await make(failWith(make429())).fromDictation('kot').catch((e) => e)
    expect(err).toBeInstanceOf(GenerationError)
    expect(err.retryable).toBe(true)
  })

  // The exact shape Vertex produced in production: the status is only in the
  // JSON inside the message.
  it('marks a 429 carried only in the message JSON as retryable', () => {
    const err = new Error('{"error":{"code":429,"message":"Resource exhausted.","status":"RESOURCE_EXHAUSTED"}}')
    expect(isRetryableRequestError(err)).toBe(true)
  })

  it('marks 500 and 503 as retryable, and a 400 as not', () => {
    expect(isRetryableRequestError(Object.assign(new Error('x'), { status: 500 }))).toBe(true)
    expect(isRetryableRequestError(Object.assign(new Error('x'), { status: 503 }))).toBe(true)
    expect(isRetryableRequestError(Object.assign(new Error('x'), { status: 400 }))).toBe(false)
  })

  it('marks a network failure, which has no HTTP status at all, as retryable', () => {
    expect(isRetryableRequestError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableRequestError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('never marks an unusable response as retryable', async () => {
    const noText = vi.fn().mockResolvedValue({ text: '' })
    expect((await make(noText).fromDictation('kot').catch((e) => e)).retryable).toBe(false)
    const notJson = vi.fn().mockResolvedValue({ text: 'not json' })
    expect((await make(notJson).fromDictation('kot').catch((e) => e)).retryable).toBe(false)
    const wrongShape = ok({ answer_pl: 'kot' })
    expect((await make(wrongShape).fromDictation('kot').catch((e) => e)).retryable).toBe(false)
  })

  it('never marks an empty transcript as retryable', async () => {
    expect((await make(ok(FULL)).fromDictation('  ').catch((e) => e)).retryable).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/generate`
Expected: `isRetryableRequestError` is not exported; `retryable` is `undefined`.

- [ ] **Step 3: Implement**

Replace `GenerationError` with:

```ts
export class GenerationError extends Error {
  /**
   * Whether trying again later can succeed (spec 2026-09-18-generation-queue
   * §6). True only when the request itself failed transiently; a response
   * that arrived but was unusable will be just as unusable next time.
   */
  readonly retryable: boolean

  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'GenerationError'
    this.retryable = opts.retryable ?? false
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 503])

/**
 * Classifies a failed generation *request*. Vertex's 429 does not always carry
 * a status property — in production it arrived as JSON inside the message
 * (`{"error":{"code":429,…,"status":"RESOURCE_EXHAUSTED"}}`) — so the message
 * is read too. An error with no HTTP status at all is a network failure: the
 * request never got an answer, which is transient by definition.
 */
export function isRetryableRequestError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null
  if (typeof e?.status === 'number') return RETRYABLE_STATUS.has(e.status)
  if (typeof e?.code === 'number') return RETRYABLE_STATUS.has(e.code)
  const message = typeof e?.message === 'string' ? e.message : ''
  const code = /"code"\s*:\s*(\d{3})/.exec(message)
  if (code) return RETRYABLE_STATUS.has(Number(code[1]))
  if (/RESOURCE_EXHAUSTED|UNAVAILABLE/.test(message)) return true
  return err instanceof TypeError || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(message)
}
```

In `run()`, change the request `catch` to:

```ts
    } catch (err) {
      throw new GenerationError(`generation request failed: ${(err as Error).message}`, {
        retryable: isRetryableRequestError(err),
      })
    }
```

Every other `new GenerationError(...)` keeps the default (not retryable).

- [ ] **Step 4: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: GenerationError says whether a retry can succeed

429, 500, 503 and network failures are retryable; an unusable response or
an empty transcript is not. Vertex's 429 is also recognised when its status
exists only as JSON inside the message, the form seen in production."
```

---

### Task 3: The approval rule and backoff

**Files:**
- Create: `lib/queue/review.ts`, `lib/queue/review.test.ts`, `lib/queue/backoff.ts`, `lib/queue/backoff.test.ts`

**Interfaces:**
- Produces from `review.ts`: `REVIEW_MS`, `MAX_IN_REVIEW`, `type ReviewRow = { id: string; transcribedAt: number; createdAt: number }`, `approvedIds(underReview: readonly ReviewRow[], now: number): Set<string>`, `reviewRemainingMs(row: ReviewRow, now: number): number`.
- Produces from `backoff.ts`: `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`, `backoffMs(attempts: number, random: () => number): number`.

- [ ] **Step 1: Write the failing tests**

`lib/queue/review.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_IN_REVIEW, REVIEW_MS, approvedIds, reviewRemainingMs, type ReviewRow } from './review'

const row = (id: string, transcribedAt: number, createdAt = transcribedAt): ReviewRow => ({ id, transcribedAt, createdAt })

describe('approvedIds', () => {
  it('keeps a recording under review until exactly 10 000 ms have passed', () => {
    expect(approvedIds([row('a', 1_000)], 1_000 + REVIEW_MS - 1).has('a')).toBe(false)
    expect(approvedIds([row('a', 1_000)], 1_000 + REVIEW_MS).has('a')).toBe(true)
  })

  it('approves the oldest once more than 5 are under review', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(`r${n}`, 1_000 + n))
    const approved = approvedIds(rows, 1_010)
    expect([...approved]).toEqual(['r1'])
    expect(MAX_IN_REVIEW).toBe(5)
  })

  it('keeps exactly 5 under review when there are 5', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(`r${n}`, 1_000 + n))
    expect(approvedIds(rows, 1_010).size).toBe(0)
  })

  // Two recordings transcribed in the same millisecond still have a stable
  // order: the one uploaded later counts as newer.
  it('breaks a transcription-time tie by upload time', () => {
    const rows = [
      row('newer', 2_000, 20), row('older', 2_000, 10),
      row('a', 2_001), row('b', 2_002), row('c', 2_003), row('d', 2_004),
    ]
    expect([...approvedIds(rows, 2_005)]).toEqual(['older'])
  })

  it('does not mutate its input', () => {
    const rows = [row('b', 2), row('a', 1)]
    approvedIds(rows, 3)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('reviewRemainingMs', () => {
  it('counts down to zero and never below', () => {
    expect(reviewRemainingMs(row('a', 1_000), 1_000)).toBe(REVIEW_MS)
    expect(reviewRemainingMs(row('a', 1_000), 7_000)).toBe(4_000)
    expect(reviewRemainingMs(row('a', 1_000), 99_000)).toBe(0)
  })
})
```

`lib/queue/backoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BACKOFF_CAP_MS, backoffMs } from './backoff'

describe('backoffMs', () => {
  it('starts between 2.5 s and 5 s', () => {
    expect(backoffMs(1, () => 0)).toBe(2_500)
    expect(backoffMs(1, () => 1)).toBe(5_000)
  })

  it('doubles with each attempt', () => {
    expect(backoffMs(2, () => 1)).toBe(10_000)
    expect(backoffMs(3, () => 1)).toBe(20_000)
  })

  it('never exceeds 5 minutes', () => {
    expect(backoffMs(30, () => 1)).toBe(BACKOFF_CAP_MS)
    expect(backoffMs(30, () => 0)).toBe(BACKOFF_CAP_MS / 2)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/queue`
Expected: both modules cannot be imported.

- [ ] **Step 3: Implement**

`lib/queue/review.ts`:

```ts
/**
 * The review window (spec 2026-09-18-generation-queue §3). Pure: no database,
 * no clock, so the list endpoint and the worker share one definition of
 * "approved" and it can be tested at its exact edges.
 */

export const REVIEW_MS = 10_000
export const MAX_IN_REVIEW = 5

export type ReviewRow = { id: string; transcribedAt: number; createdAt: number }

/** Newest first — the order the recording screen shows, and the order the "only the 5 newest stay" rule counts in. */
function newestFirst(a: ReviewRow, b: ReviewRow): number {
  return b.transcribedAt - a.transcribedAt || b.createdAt - a.createdAt
}

/**
 * Which recordings under review are approved at `now`: those 10 s past their
 * transcript, and every one beyond the 5 newest. Rows past 10 s are always the
 * oldest, so "5 newest of all" and "5 newest still under review" pick the same
 * rows.
 */
export function approvedIds(underReview: readonly ReviewRow[], now: number): Set<string> {
  const approved = new Set<string>()
  ;[...underReview].sort(newestFirst).forEach((row, i) => {
    if (i >= MAX_IN_REVIEW || now - row.transcribedAt >= REVIEW_MS) approved.add(row.id)
  })
  return approved
}

export function reviewRemainingMs(row: ReviewRow, now: number): number {
  return Math.max(0, row.transcribedAt + REVIEW_MS - now)
}
```

`lib/queue/backoff.ts`:

```ts
/**
 * Progressive backoff for retrying generation (spec 2026-09-18-generation-queue
 * §6): 5 s, 10 s, 20 s, … capped at 5 min, with equal jitter so retries after
 * a shared 429 do not all land at once. `random` is injected for tests.
 */
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 300_000

export function backoffMs(attempts: number, random: () => number): number {
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1))
  return Math.round(d / 2 + random() * (d / 2))
}
```

- [ ] **Step 4: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: the review rule and backoff, as pure functions"
```

---

### Task 4: The job store and runner

**Files:**
- Create: `lib/queue/jobs.ts`, `lib/queue/jobs.test.ts`

**Interfaces:**
- Consumes: `approvedIds`, `ReviewRow` (Task 3); `backoffMs` (Task 3); `GenerationError` (Task 2); `generationJobs`, `captures` schema (Task 1).
- Produces:
  - `type JobKind = 'new' | 'regenerate' | 'rerecognized'`; `type JobRow = typeof generationJobs.$inferSelect`; `MAX_ATTEMPTS_NON_RETRYABLE = 3`
  - `enqueueJob(db: Db, input: { kind: JobKind; captureId?: string | null; cardId?: string | null }, now: Date): string`
  - `hasActiveJob(db: Db, cardId: string): boolean`; `activeJobCardIds(db: Db): string[]`
  - `underReview(db: Db): ReviewRow[]`
  - `promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] }`
  - `recoverRunning(db: Db): number`
  - `type JobHandler = { run(job: JobRow, now: Date): Promise<void>; giveUp(job: JobRow, lastError: string, now: Date): void }`; `type JobHandlers = Record<JobKind, JobHandler>`
  - `type RunnerState = { pausedUntil: number }`; `type RunOutcome = 'paused' | 'idle' | 'done' | 'retry' | 'gave-up'`
  - `runNextJob(db: Db, handlers: JobHandlers, state: RunnerState, now: Date, random: () => number): Promise<RunOutcome>`

- [ ] **Step 1: Write the failing tests**

`lib/queue/jobs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { captures, generationJobs } from '../db/schema'
import { GenerationError } from '../generate'
import {
  activeJobCardIds, enqueueJob, hasActiveJob, promoteApproved, recoverRunning, runNextJob,
  type JobHandlers,
} from './jobs'

const T = 1_000_000
const at = (ms: number) => new Date(T + ms)
const zero = () => 0

function capture(db: ReturnType<typeof createTestDb>['db'], id: string, over: Partial<typeof captures.$inferInsert> = {}) {
  db.insert(captures).values({
    id, audioMediaId: null, transcript: id, status: 'transcribed', error: null, generationJson: null,
    cardId: null, createdAt: T, transcribedAt: T, duplicateOf: null, ...over,
  }).run()
}

function fakeHandlers(run = vi.fn().mockResolvedValue(undefined)) {
  const giveUp = vi.fn()
  const h = { run, giveUp }
  return { handlers: { new: h, regenerate: h, rerecognized: h } as JobHandlers, run, giveUp }
}

const job = (db: ReturnType<typeof createTestDb>['db'], id: string) =>
  db.select().from(generationJobs).where(eq(generationJobs.id, id)).get()!

describe('runNextJob', () => {
  it('runs the oldest due job and marks it done', async () => {
    const { db } = createTestDb()
    const first = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const second = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(1))
    const { handlers, run } = fakeHandlers()
    expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)).toBe('done')
    expect(run.mock.calls[0][0].id).toBe(first)
    expect(job(db, first).status).toBe('done')
    expect(job(db, second).status).toBe('queued')
  })

  it('is idle when nothing is due', async () => {
    const { db } = createTestDb()
    const { handlers } = fakeHandlers()
    expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(0), zero)).toBe('idle')
  })

  // Spec §6: the quota is per project, so a retryable failure pauses the whole
  // queue — the next job is not tried into the same exhausted quota.
  it('re-queues a 429 with backoff and pauses every job until it passes', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'regenerate' }, at(0))
    enqueueJob(db, { kind: 'regenerate' }, at(1))
    const run = vi.fn().mockRejectedValueOnce(new GenerationError('429', { retryable: true })).mockResolvedValue(undefined)
    const { handlers } = fakeHandlers(run)
    const state = { pausedUntil: 0 }

    expect(await runNextJob(db, handlers, state, at(10), zero)).toBe('retry')
    expect(job(db, a)).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: T + 10 + 2_500, lastError: '429' })
    expect(state.pausedUntil).toBe(T + 10 + 2_500)

    expect(await runNextJob(db, handlers, state, at(2_000), zero)).toBe('paused')
    expect(run).toHaveBeenCalledTimes(1)

    expect(await runNextJob(db, handlers, state, at(2_510), zero)).toBe('done')
    expect(job(db, a).status).toBe('done')
  })

  it('retries a 429 indefinitely rather than giving up', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'regenerate' }, at(0))
    const { handlers, giveUp } = fakeHandlers(vi.fn().mockRejectedValue(new GenerationError('429', { retryable: true })))
    const state = { pausedUntil: 0 }
    for (let i = 0; i < 6; i++) {
      await runNextJob(db, handlers, state, new Date(Math.max(state.pausedUntil, T)), zero)
    }
    expect(job(db, a)).toMatchObject({ status: 'queued', attempts: 6 })
    expect(giveUp).not.toHaveBeenCalled()
  })

  it('gives a non-retryable failure 3 attempts without pausing, then gives up once', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'new', captureId: null }, at(0))
    const { handlers, giveUp } = fakeHandlers(vi.fn().mockRejectedValue(new GenerationError('unusable')))
    const state = { pausedUntil: 0 }

    expect(await runNextJob(db, handlers, state, at(0), zero)).toBe('retry')
    expect(state.pausedUntil).toBe(0)
    expect(await runNextJob(db, handlers, state, at(3_000), zero)).toBe('retry')
    expect(await runNextJob(db, handlers, state, at(10_000), zero)).toBe('gave-up')

    expect(giveUp).toHaveBeenCalledTimes(1)
    expect(giveUp.mock.calls[0][1]).toBe('unusable')
    expect(job(db, a)).toMatchObject({ status: 'failed', attempts: 3, lastError: 'unusable', finishedAt: T + 10_000 })
  })

  it('treats an error that is not a GenerationError as non-retryable', async () => {
    const { db } = createTestDb()
    enqueueJob(db, { kind: 'regenerate' }, at(0))
    const { handlers } = fakeHandlers(vi.fn().mockRejectedValue(new Error('no such card')))
    const state = { pausedUntil: 0 }
    expect(await runNextJob(db, handlers, state, at(0), zero)).toBe('retry')
    expect(state.pausedUntil).toBe(0)
  })

  it('shows a new recording as generating while its job runs, and queued again after a 429', async () => {
    const { db } = createTestDb()
    capture(db, 'c1', { status: 'queued' })
    enqueueJob(db, { kind: 'new', captureId: 'c1' }, at(0))
    let during = ''
    const run = vi.fn(async () => {
      during = db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status
      throw new GenerationError('429', { retryable: true })
    })
    await runNextJob(db, fakeHandlers(run).handlers, { pausedUntil: 0 }, at(0), zero)
    expect(during).toBe('generating')
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
  })
})

describe('promoteApproved', () => {
  it('queues a new word once its review window has passed, and leaves a fresh one', () => {
    const { db } = createTestDb()
    capture(db, 'old', { transcribedAt: T })
    capture(db, 'fresh', { transcribedAt: T + 5_000 })
    expect(promoteApproved(db, at(10_000))).toEqual({ queued: ['old'], duplicates: [] })
    expect(db.select().from(captures).where(eq(captures.id, 'old')).get()!.status).toBe('queued')
    expect(db.select().from(captures).where(eq(captures.id, 'fresh')).get()!.status).toBe('transcribed')
    const jobs = db.select().from(generationJobs).all()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'new', captureId: 'old', status: 'queued' })
  })

  // Spec §4: a word already in the deck is never queued — no Gemini call, no card.
  it('marks a już masz word duplicate and queues nothing', () => {
    const { db, sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due) VALUES ('k', 'ru_to_pl', 'kot', 'kot', 'ready', 1, 1, 1)`).run()
    capture(db, 'dup', { duplicateOf: 'k' })
    expect(promoteApproved(db, at(10_000))).toEqual({ queued: [], duplicates: ['dup'] })
    expect(db.select().from(generationJobs).all()).toHaveLength(0)
  })

  it('promotes a recording only once', () => {
    const { db } = createTestDb()
    capture(db, 'old')
    promoteApproved(db, at(10_000))
    promoteApproved(db, at(20_000))
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })
})

describe('recoverRunning', () => {
  it('returns interrupted jobs and their recordings to the queue', () => {
    const { db } = createTestDb()
    capture(db, 'c1', { status: 'generating' })
    const id = enqueueJob(db, { kind: 'new', captureId: 'c1' }, at(0))
    db.update(generationJobs).set({ status: 'running' }).where(eq(generationJobs.id, id)).run()
    expect(recoverRunning(db)).toBe(1)
    expect(job(db, id).status).toBe('queued')
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
  })
})

describe('active jobs', () => {
  it('reports cards with a queued or running job, and not finished ones', () => {
    const { db, sqlite } = createTestDb()
    for (const id of ['a', 'b', 'c']) {
      sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due) VALUES (?, 'ru_to_pl', ?, ?, 'needs_input', 1, 1, 1)`).run(id, id, id)
    }
    enqueueJob(db, { kind: 'regenerate', cardId: 'a' }, at(0))
    const done = enqueueJob(db, { kind: 'regenerate', cardId: 'b' }, at(0))
    db.update(generationJobs).set({ status: 'done' }).where(eq(generationJobs.id, done)).run()
    expect(hasActiveJob(db, 'a')).toBe(true)
    expect(hasActiveJob(db, 'b')).toBe(false)
    expect(activeJobCardIds(db)).toEqual(['a'])
  })
})
```

Before relying on the raw `INSERT INTO cards` lines, check `migrations/001-init.sql` supplies defaults for every other NOT NULL column; add columns to the insert if the run reports a NOT NULL failure.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/queue/jobs.test.ts`
Expected: `./jobs` cannot be imported.

- [ ] **Step 3: Implement `lib/queue/jobs.ts`**

```ts
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, generationJobs } from '../db/schema'
import { GenerationError } from '../generate'
import { backoffMs } from './backoff'
import { approvedIds, type ReviewRow } from './review'

/**
 * The generation queue (spec 2026-09-18-generation-queue §5–§6): storage,
 * promotion of approved recordings, crash recovery, and running one job
 * through handlers the caller supplies — so this module knows nothing about
 * cards or Gemini, and every rule here is testable with fakes.
 */

export type JobKind = 'new' | 'regenerate' | 'rerecognized'
export type JobRow = typeof generationJobs.$inferSelect

/** A non-retryable failure gets this many attempts, then the job gives up (§6). */
export const MAX_ATTEMPTS_NON_RETRYABLE = 3

export function enqueueJob(
  db: Db,
  input: { kind: JobKind; captureId?: string | null; cardId?: string | null },
  now: Date,
): string {
  const id = randomUUID()
  db.insert(generationJobs)
    .values({
      id,
      kind: input.kind,
      captureId: input.captureId ?? null,
      cardId: input.cardId ?? null,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now.getTime(),
      lastError: null,
      createdAt: now.getTime(),
      finishedAt: null,
    })
    .run()
  return id
}

const ACTIVE = ['queued', 'running'] as const

export function hasActiveJob(db: Db, cardId: string): boolean {
  return !!db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.cardId, cardId), inArray(generationJobs.status, ACTIVE)))
    .get()
}

export function activeJobCardIds(db: Db): string[] {
  const rows = db
    .selectDistinct({ cardId: generationJobs.cardId })
    .from(generationJobs)
    .where(and(inArray(generationJobs.status, ACTIVE), isNotNull(generationJobs.cardId)))
    .all()
  return rows.map((r) => r.cardId!).sort()
}

/** Recordings still under review: transcribed and not yet promoted (§3). */
export function underReview(db: Db): ReviewRow[] {
  return db
    .select({ id: captures.id, transcribedAt: captures.transcribedAt, createdAt: captures.createdAt })
    .from(captures)
    .where(and(eq(captures.status, 'transcribed'), isNotNull(captures.transcribedAt)))
    .all()
    .map((r) => ({ id: r.id, transcribedAt: r.transcribedAt!, createdAt: r.createdAt }))
}

/**
 * Every approved recording leaves review: a word already in the deck becomes
 * 'duplicate' and is never queued (§4); any other becomes 'queued' with a
 * `new` job. One transaction, so a recording is never queued without its job.
 */
export function promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] } {
  const approved = approvedIds(underReview(db), now.getTime())
  const queued: string[] = []
  const duplicates: string[] = []
  db.transaction((tx) => {
    for (const id of approved) {
      const row = tx
        .select({ duplicateOf: captures.duplicateOf })
        .from(captures)
        .where(and(eq(captures.id, id), eq(captures.status, 'transcribed')))
        .get()
      if (!row) continue
      if (row.duplicateOf) {
        tx.update(captures).set({ status: 'duplicate' }).where(eq(captures.id, id)).run()
        duplicates.push(id)
      } else {
        tx.update(captures).set({ status: 'queued' }).where(eq(captures.id, id)).run()
        enqueueJob(tx as unknown as Db, { kind: 'new', captureId: id }, now)
        queued.push(id)
      }
    }
  })
  return { queued, duplicates }
}

/** At startup: a job left 'running' was interrupted; it goes back to the queue (§6). */
export function recoverRunning(db: Db): number {
  const running = db.select().from(generationJobs).where(eq(generationJobs.status, 'running')).all()
  db.transaction((tx) => {
    for (const job of running) {
      tx.update(generationJobs).set({ status: 'queued' }).where(eq(generationJobs.id, job.id)).run()
      if (job.kind === 'new' && job.captureId) {
        tx.update(captures).set({ status: 'queued' }).where(eq(captures.id, job.captureId)).run()
      }
    }
  })
  return running.length
}

export type JobHandler = {
  run(job: JobRow, now: Date): Promise<void>
  /** Called once, when a job gives up after its last non-retryable failure (§6). */
  giveUp(job: JobRow, lastError: string, now: Date): void
}
export type JobHandlers = Record<JobKind, JobHandler>

/** Lives in the worker's memory; a restart clears it, costing at most one extra 429 (§6). */
export type RunnerState = { pausedUntil: number }
export type RunOutcome = 'paused' | 'idle' | 'done' | 'retry' | 'gave-up'

function setJob(db: Db, id: string, patch: Partial<JobRow>): void {
  db.update(generationJobs).set(patch).where(eq(generationJobs.id, id)).run()
}

function setNewCaptureStatus(db: Db, job: JobRow, status: 'queued' | 'generating'): void {
  if (job.kind === 'new' && job.captureId) {
    db.update(captures).set({ status }).where(eq(captures.id, job.captureId)).run()
  }
}

/**
 * Runs at most one job: the oldest queued one that is due. A retryable failure
 * re-queues it with backoff AND pauses the whole queue for the same delay,
 * because the quota is per project. A non-retryable one gets
 * MAX_ATTEMPTS_NON_RETRYABLE attempts without pausing, then its handler's
 * giveUp runs once.
 */
export async function runNextJob(
  db: Db,
  handlers: JobHandlers,
  state: RunnerState,
  now: Date,
  random: () => number,
): Promise<RunOutcome> {
  const t = now.getTime()
  if (t < state.pausedUntil) return 'paused'
  const job = db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.status, 'queued'), lte(generationJobs.nextAttemptAt, t)))
    .orderBy(asc(generationJobs.createdAt))
    .get()
  if (!job) return 'idle'

  setJob(db, job.id, { status: 'running' })
  setNewCaptureStatus(db, job, 'generating')
  try {
    await handlers[job.kind].run(job, now)
    setJob(db, job.id, { status: 'done', finishedAt: t, lastError: null })
    return 'done'
  } catch (err) {
    const attempts = job.attempts + 1
    const message = String((err as Error)?.message ?? err)
    const retryable = err instanceof GenerationError && err.retryable
    if (retryable || attempts < MAX_ATTEMPTS_NON_RETRYABLE) {
      const next = t + backoffMs(attempts, random)
      if (retryable) state.pausedUntil = next
      setJob(db, job.id, { status: 'queued', attempts, nextAttemptAt: next, lastError: message })
      setNewCaptureStatus(db, job, 'queued')
      return 'retry'
    }
    handlers[job.kind].giveUp(job, message, now)
    setJob(db, job.id, { status: 'failed', attempts, lastError: message, finishedAt: t })
    return 'gave-up'
  }
}
```

If `tsc` rejects passing `tx` where `Db` is expected, keep the `as unknown as Db` cast only on that one call and say so in the report; do not widen `enqueueJob`'s signature.

- [ ] **Step 4: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: the generation job store and runner

Promotes approved recordings (a już masz word is never queued), recovers
interrupted jobs, and runs one due job at a time through injected handlers.
A retryable failure pauses the whole queue with backoff; a non-retryable one
gets three attempts and then gives up once."
```

---

### Task 5: Split the pipeline — recognition now, generation queued

**Files:**
- Modify: `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `app/api/captures/route.ts`, `app/api/captures/[id]/retry/route.ts`, `app/api/captures/[id]/jezyk/route.ts` and their tests, `app/fiszki/[id]/page.tsx` (its `relanguage` only)

**Interfaces:**
- Consumes: `enqueueJob`, `hasActiveJob`, `underReview`, `JobHandlers` (Task 4); `approvedIds`, `reviewRemainingMs` (Task 3); `regenerateCard`, `applyGeneratedFields`, `createCard` (existing).
- Produces:
  - `type RecognizeDeps = { db: Db; transcriber: Transcriber }`; `CaptureDeps` unchanged
  - `CaptureView` = the existing fields **plus** `inReview: boolean` and `reviewRemainingMs: number | null`; `duplicateOf` now comes from `captures.duplicate_of` (Task 8 trims the fields the chip no longer uses)
  - `knownCardFor(db: Db, transcript: string): string | null`
  - `recognizeCapture(deps: RecognizeDeps, captureId: string, now: Date): Promise<void>`
  - `rerecognize(deps: RecognizeDeps, captureId: string, lang: DictationLang, now: Date): Promise<{ queued: boolean; error: string | null }>`
  - `listOnScreen(db: Db, since: number, now: Date): CaptureView[]`
  - `pendingCaptures(db: Db): { id: string; transcript: string | null; status: 'queued' | 'generating' }[]`
  - `generateNewCard(deps: CaptureDeps, captureId: string, now: Date): Promise<void>`; `giveUpNewCard(db: Db, captureId: string, lastError: string, now: Date): void`
  - `applyRerecognized(deps: CaptureDeps, captureId: string, now: Date): Promise<void>`; `giveUpRerecognized(db: Db, captureId: string, lastError: string): void`
  - `jobHandlers(deps: CaptureDeps): JobHandlers`
  - `creatorCaptureId` unchanged
  - Removed: `processCapture`, `retranscribe`, `listCaptures`
  - `POST /api/captures/:id/jezyk` → `200 { queued: boolean; error: string | null }` | `400`

This task removes functions that routes call, so it updates those routes in the same commit to keep every gate green. Between this task and Task 6 nothing runs queued jobs; that is expected on the branch.

- [ ] **Step 1: Write the failing tests**

In `lib/capture/pipeline.test.ts`, replace `describe('processCapture', …)`, `describe('retranscribe', …)` and the `listCaptures` tests with the tests below. Before deleting an old test, find the new test that covers its behaviour; if none does, port it to the function that now owns that behaviour (transcription → `recognizeCapture`; generation and card creation → `generateNewCard`; re-recognition of a card → `rerecognize` + `applyRerecognized`) with the same assertions, and list every port in your report.

```ts
import { createCapture, recognizeCapture, rerecognize, listOnScreen, pendingCaptures, knownCardFor,
  generateNewCard, giveUpNewCard, applyRerecognized, creatorCaptureId } from './pipeline'
import { enqueueJob } from '../queue/jobs'
import { generationJobs } from '../db/schema'

async function recognized(d: ReturnType<typeof deps>, transcript: string, now = NOW) {
  d.transcriber.transcribe = vi.fn().mockResolvedValue(transcript)
  const id = createCapture(d.db, AUDIO, now)
  await recognizeCapture(d, id, now)
  return id
}

const row = (d: ReturnType<typeof deps>, id: string) =>
  d.db.select().from(captures).where(eq(captures.id, id)).get()!

describe('recognizeCapture', () => {
  it('stores the transcript and opens the review window', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    expect(row(d, id)).toMatchObject({ status: 'transcribed', transcript: 'złośliwy', transcribedAt: NOW.getTime(), duplicateOf: null })
  })

  it('makes no Gemini call — generation is queued, not run here', async () => {
    const d = deps()
    await recognized(d, 'złośliwy')
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('keeps the audio and marks failed when recognition fails', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('unintelligible')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture(d, id, NOW)
    expect(row(d, id)).toMatchObject({ status: 'failed', error: 'unintelligible' })
    expect(row(d, id).audioMediaId).not.toBeNull()
  })

  it('writes nothing for a recording rejected while Speech-to-Text ran', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    d.transcriber.transcribe = vi.fn(async () => {
      d.db.delete(captures).where(eq(captures.id, id)).run()
      return 'kot'
    })
    await recognizeCapture(d, id, NOW)
    expect(d.db.select().from(captures).all()).toHaveLength(0)
  })

  it('flags a word already in the deck as już masz', async () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    const id = await recognized(d, 'Kot.')
    expect(row(d, id).duplicateOf).toBe(cardId)
  })
})

describe('knownCardFor', () => {
  it('matches a Latin transcript on the answer key', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'wścieklizna' }), NOW)
    expect(knownCardFor(d.db, 'Wścieklizna!')).toBe(cardId)
  })

  it('matches a Cyrillic transcript on the Russian prompt', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'grobowiec', promptText: 'склеп' }), NOW)
    expect(knownCardFor(d.db, 'Склеп.')).toBe(cardId)
  })

  // Spec §4: best-effort by design. answerKey never strips diacritics, so a
  // transcript that lost one does not match — the generation-time dedup
  // catches it instead.
  it('misses a transcript that lost a diacritic', () => {
    const d = deps()
    createCard(d.db, input({ answerPl: 'wścieklizna' }), NOW)
    expect(knownCardFor(d.db, 'wscieklizna')).toBeNull()
  })

  it('ignores deleted cards and pl_to_pl cards', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    deleteCard(d.db, cardId, NOW)
    createCard(d.db, input({ answerPl: 'pies', type: 'pl_to_pl' }), NOW)
    expect(knownCardFor(d.db, 'kot')).toBeNull()
    expect(knownCardFor(d.db, 'pies')).toBeNull()
  })
})

describe('rerecognize', () => {
  it('replaces the transcript under review and restarts the window', async () => {
    const d = deps()
    const id = await recognized(d, 'sklep')
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    const later = new Date(NOW.getTime() + 7_000)
    expect(await rerecognize(d, id, 'ru', later)).toEqual({ queued: false, error: null })
    expect(row(d, id)).toMatchObject({ status: 'transcribed', transcript: 'склеп', transcribedAt: later.getTime() })
    expect((d.transcriber.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0].lang).toBe('ru')
  })

  it('clears a stale już masz when the new transcript is not in the deck', async () => {
    const d = deps()
    createCard(d.db, input({ answerPl: 'sklep' }), NOW)
    const id = await recognized(d, 'sklep')
    expect(row(d, id).duplicateOf).not.toBeNull()
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    await rerecognize(d, id, 'ru', NOW)
    expect(row(d, id).duplicateOf).toBeNull()
  })

  it('queues a rerecognized job for a recording that already has a card', async () => {
    const d = deps()
    const id = await recognized(d, 'sklep')
    await generateNewCard(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    expect(await rerecognize(d, id, 'ru', NOW)).toEqual({ queued: true, error: null })
    const jobs = d.db.select().from(generationJobs).all()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'rerecognized', captureId: id, cardId: row(d, id).cardId })
    expect(d.generator.fromDictation).toHaveBeenCalledTimes(1) // only generateNewCard's call
  })

  it('returns a Speech-to-Text failure and leaves the transcript', async () => {
    const d = deps()
    const id = await recognized(d, 'sklep')
    d.transcriber.transcribe = vi.fn().mockRejectedValue(new Error('unintelligible'))
    expect(await rerecognize(d, id, 'ru', NOW)).toEqual({ queued: false, error: 'unintelligible' })
    expect(row(d, id).transcript).toBe('sklep')
  })
})

describe('listOnScreen', () => {
  it('shows a recording under review with its remaining time, then drops it when approved', async () => {
    const d = deps()
    const id = await recognized(d, 'kot')
    const at4s = new Date(NOW.getTime() + 4_000)
    expect(listOnScreen(d.db, 0, at4s)).toEqual([
      expect.objectContaining({ id, inReview: true, reviewRemainingMs: 6_000 }),
    ])
    expect(listOnScreen(d.db, 0, new Date(NOW.getTime() + 10_000))).toEqual([])
  })

  it('keeps a failed recognition on screen until acted on', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('x')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture(d, id, NOW)
    expect(listOnScreen(d.db, 0, new Date(NOW.getTime() + 60_000))).toEqual([
      expect.objectContaining({ id, status: 'failed', inReview: false, reviewRemainingMs: null }),
    ])
  })

  it('shows at most the 5 newest recordings under review', async () => {
    const d = deps()
    for (let i = 0; i < 6; i++) await recognized(d, `w${i}`, new Date(NOW.getTime() + i))
    const shown = listOnScreen(d.db, 0, new Date(NOW.getTime() + 10))
    expect(shown.map((c) => c.transcript)).toEqual(['w5', 'w4', 'w3', 'w2', 'w1'])
  })
})

describe('generateNewCard', () => {
  it('creates a ready card from the transcript and records it on the recording', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    await generateNewCard(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card).toMatchObject({ status: 'ready', answerPl: GENERATED.answer_pl, wordKind: GENERATED.kind })
    expect(row(d, id)).toMatchObject({ status: 'generated', cardId: card.id, error: null })
  })

  it('throws a generation failure for the queue to handle, creating nothing', async () => {
    const d = deps({ generator: { fromDictation: vi.fn().mockRejectedValue(new GenerationError('429', { retryable: true })) } })
    const id = await recognized(d, 'złośliwy')
    await expect(generateNewCard(d, id, NOW)).rejects.toThrow('429')
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('creates nothing for a recording deleted while Gemini ran', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    d.generator.fromDictation = vi.fn(async () => {
      d.db.delete(captures).where(eq(captures.id, id)).run()
      return GENERATED
    })
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('is idempotent — a recording that already has a card makes no second one', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    await generateNewCard(d, id, NOW)
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
  })
})

describe('giveUpNewCard', () => {
  it('keeps the word as a needs_input card with the last error', async () => {
    const d = deps()
    const id = await recognized(d, 'Zdrów jak ryba.')
    giveUpNewCard(d.db, id, 'unusable payload', NOW)
    const card = d.db.select().from(cards).get()!
    expect(card).toMatchObject({ status: 'needs_input', answerPl: 'Zdrów jak ryba.', promptText: null, wordKind: null })
    expect(row(d, id)).toMatchObject({ status: 'generated', cardId: card.id, error: 'unusable payload' })
  })
})

describe('applyRerecognized', () => {
  // The creator rule from the previous branch's critical fix, now on the queue.
  it('rewrites the card in place when this recording created it', async () => {
    const d = deps()
    const id = await recognized(d, 'sklep')
    await generateNewCard(d, id, NOW)
    const before = d.db.select().from(cards).get()!
    d.db.update(captures).set({ transcript: 'склеп' }).where(eq(captures.id, id)).run()
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)
    await applyRerecognized(d, id, NOW)
    const all = d.db.select().from(cards).all()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: before.id, answerPl: RU_GENERATED.answer_pl, promptText: RU_GENERATED.prompt_ru })
  })

  it('never rewrites a card another recording created', async () => {
    const d = deps()
    const a = await recognized(d, 'sklep')
    await generateNewCard(d, a, NOW)
    const shop = d.db.select().from(cards).get()!
    const b = await recognized(d, 'sklep', new Date(NOW.getTime() + 1))
    await generateNewCard(d, b, NOW)                       // dedups onto A's card
    expect(row(d, b).cardId).toBe(shop.id)
    d.db.update(captures).set({ transcript: 'склеп' }).where(eq(captures.id, b)).run()
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)

    await applyRerecognized(d, b, NOW)

    expect(d.db.select().from(cards).where(eq(cards.id, shop.id)).get()).toEqual(shop)
    expect(row(d, b).cardId).not.toBe(shop.id)
  })

  it('throws a generation failure and leaves the card as it was', async () => {
    const d = deps()
    const id = await recognized(d, 'sklep')
    await generateNewCard(d, id, NOW)
    const before = d.db.select().from(cards).get()!
    d.generator.fromDictation = vi.fn().mockRejectedValue(new GenerationError('429', { retryable: true }))
    await expect(applyRerecognized(d, id, NOW)).rejects.toThrow('429')
    expect(d.db.select().from(cards).get()).toEqual(before)
  })
})

describe('pendingCaptures', () => {
  it('lists recordings waiting for or in generation, newest first', () => {
    const d = deps()
    for (const [id, status, t] of [['q', 'queued', 1], ['g', 'generating', 2], ['x', 'generated', 3]] as const) {
      d.db.insert(captures).values({
        id, audioMediaId: null, transcript: id, status, error: null, generationJson: null,
        cardId: null, createdAt: t, transcribedAt: t, duplicateOf: null,
      }).run()
    }
    expect(pendingCaptures(d.db)).toEqual([
      { id: 'g', transcript: 'g', status: 'generating' },
      { id: 'q', transcript: 'q', status: 'queued' },
    ])
  })
})
```

Import `createCard`, `deleteCard` and the `input()` helper the file needs (reuse `lib/cards/service.test.ts`'s shape: add a local `input(over)` returning a full `CreateCardInput` with `type: 'ru_to_pl'`, `promptText: 'злобный'`, `status: 'ready'`, nulls elsewhere, `wordKind: null`, `formsJson: null`). Import `GenerationError` from `../generate`.

Route tests: update `app/api/captures/[id]/jezyk/route.test.ts` so a recording under review returns `{ queued: false, error: null }` and its transcript is replaced, a recording with a card returns `{ queued: true, error: null }` with one `rerecognized` job, and the language-validation 400 test stays. Update `app/api/captures/route.test.ts` (if present) so GET returns only on-screen recordings.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/capture`
Expected: the new exports do not exist.

- [ ] **Step 3: Implement the pipeline**

In `lib/capture/pipeline.ts`: add imports

```ts
import { inArray } from 'drizzle-orm'
import { regenerateCard } from '../cards/service'
import { enqueueJob, hasActiveJob, underReview, type JobHandlers } from '../queue/jobs'
import { approvedIds, reviewRemainingMs } from '../queue/review'
```

(merge them into the existing import lines). Delete `processCapture`, `retranscribe` and `listCaptures`. Extend `CaptureView` with:

```ts
  /** Transcribed and not yet approved: rejectable, with the bar running (§3). */
  inReview: boolean
  /** Server-computed, so the phone's clock cannot distort the bar. Null when not under review. */
  reviewRemainingMs: number | null
```

Then add:

```ts
export type RecognizeDeps = { db: Db; transcriber: Transcriber }

const CYRILLIC = /[Ѐ-ӿ]/

/**
 * `już masz` at recognition time (spec 2026-09-18-generation-queue §4). Checks
 * the raw transcript against live ru_to_pl cards — new dictations are always
 * ru_to_pl, and dedup is type-scoped. Best-effort by design: a card is keyed by
 * its generated answer, so a transcript that lost a diacritic misses here, and
 * createCard's dedup at generation time stays as the backstop.
 */
export function knownCardFor(db: Db, transcript: string): string | null {
  const key = answerKey(transcript)
  if (!key) return null
  const live = and(eq(cards.type, 'ru_to_pl'), isNull(cards.deletedAt))
  if (!CYRILLIC.test(transcript)) {
    return db.select({ id: cards.id }).from(cards).where(and(live, eq(cards.answerKey, key))).get()?.id ?? null
  }
  // The Russian prompt is stored raw, not keyed, so keys are compared in JS —
  // the same personal-scale trade-off as searchCards.
  const match = db
    .select({ id: cards.id, promptText: cards.promptText })
    .from(cards)
    .where(and(live, isNotNull(cards.promptText)))
    .all()
    .find((c) => answerKey(c.promptText!) === key)
  return match?.id ?? null
}

/**
 * Recognises an uploaded (or failed) recording and opens its review window.
 * Makes no Gemini call: generation is queued once the recording is approved.
 */
export async function recognizeCapture(deps: RecognizeDeps, captureId: string, now: Date): Promise<void> {
  const { db, transcriber } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture) throw new Error(`no such capture: ${captureId}`)
  if (capture.status !== 'uploaded' && capture.status !== 'failed') return
  const audio = capture.audioMediaId ? getMedia(db, capture.audioMediaId) : null
  if (!audio) {
    db.update(captures)
      .set({ status: 'failed', error: capture.audioMediaId ? 'audio missing' : 'no audio' })
      .where(eq(captures.id, captureId))
      .run()
    return
  }
  let transcript: string
  try {
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime })
  } catch (err) {
    // Audio is deliberately retained: the word is recoverable by retrying.
    db.update(captures)
      .set({ status: 'failed', error: String((err as Error).message ?? err) })
      .where(eq(captures.id, captureId))
      .run()
    return
  }
  // The recording may have been rejected while Speech-to-Text ran; an update
  // of a deleted row is a no-op, so no re-read is needed.
  db.update(captures)
    .set({
      transcript,
      status: 'transcribed',
      transcribedAt: now.getTime(),
      duplicateOf: knownCardFor(db, transcript),
      error: null,
    })
    .where(eq(captures.id, captureId))
    .run()
}

/**
 * Re-recognises a recording's stored audio in the language the user names.
 * Speech-to-Text stays synchronous (fast, its own quota). Under review, the
 * transcript is replaced and the 10 s restarts (§3). With a card, the Gemini
 * half is queued as a `rerecognized` job (§5).
 */
export async function rerecognize(
  deps: RecognizeDeps,
  captureId: string,
  lang: DictationLang,
  now: Date,
): Promise<{ queued: boolean; error: string | null }> {
  const { db, transcriber } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture) throw new Error(`no such capture: ${captureId}`)
  const audio = capture.audioMediaId ? getMedia(db, capture.audioMediaId) : null
  if (!audio) {
    db.update(captures).set({ error: 'audio missing' }).where(eq(captures.id, captureId)).run()
    return { queued: false, error: 'audio missing' }
  }
  let transcript: string
  try {
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime, lang })
  } catch (err) {
    const message = String((err as Error).message ?? err)
    db.update(captures).set({ error: message }).where(eq(captures.id, captureId)).run()
    return { queued: false, error: message }
  }
  const still = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!still) return { queued: false, error: null }

  if (still.cardId) {
    db.update(captures).set({ transcript, error: null }).where(eq(captures.id, captureId)).run()
    if (!hasActiveJob(db, still.cardId)) {
      enqueueJob(db, { kind: 'rerecognized', captureId, cardId: still.cardId }, now)
    }
    return { queued: true, error: null }
  }
  const reopen = still.status === 'transcribed' || still.status === 'failed'
  db.update(captures)
    .set({
      transcript,
      duplicateOf: knownCardFor(db, transcript),
      error: null,
      // Under review (or its first recognition failed): back into review with
      // a fresh 10 s. Already approved and waiting: its `new` job reads the
      // transcript when it runs, so only the text changes.
      ...(reopen ? { status: 'transcribed' as const, transcribedAt: now.getTime() } : {}),
    })
    .where(eq(captures.id, captureId))
    .run()
  return { queued: false, error: null }
}

/**
 * What the recording screen shows (§7.1): uploaded, failed-recognition and
 * still-under-review recordings within `since`. An approved recording drops
 * out of this list at the moment it is approved — one rule, evaluated here and
 * in the worker.
 */
export function listOnScreen(db: Db, since: number, now: Date): CaptureView[] {
  const t = now.getTime()
  const review = new Map(underReview(db).map((r) => [r.id, r]))
  const approved = approvedIds([...review.values()], t)
  return db
    .select({
      id: captures.id,
      status: captures.status,
      transcript: captures.transcript,
      error: captures.error,
      cardId: captures.cardId,
      duplicateOf: captures.duplicateOf,
      audioMediaId: captures.audioMediaId,
      createdAt: captures.createdAt,
      cardType: cards.type,
      wordKind: cards.wordKind,
    })
    .from(captures)
    .leftJoin(cards, eq(cards.id, captures.cardId))
    .where(and(gt(captures.createdAt, since), inArray(captures.status, ['uploaded', 'transcribed', 'failed'])))
    .orderBy(desc(captures.createdAt))
    .all()
    .filter((c) => c.status !== 'transcribed' || (review.has(c.id) && !approved.has(c.id)))
    .map((c) => {
      const r = c.status === 'transcribed' ? review.get(c.id)! : null
      return { ...c, inReview: r !== null, reviewRemainingMs: r ? reviewRemainingMs(r, t) : null }
    })
}

/** Recordings approved and waiting for, or in, generation (§7.2). */
export function pendingCaptures(db: Db): { id: string; transcript: string | null; status: 'queued' | 'generating' }[] {
  return db
    .select({ id: captures.id, transcript: captures.transcript, status: captures.status })
    .from(captures)
    .where(inArray(captures.status, ['queued', 'generating']))
    .orderBy(desc(captures.createdAt))
    .all() as { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
}

/** Job `new`: an approved recording becomes a card. A generation failure is thrown for the queue to classify. */
export async function generateNewCard(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || capture.cardId || !capture.transcript) return
  const transcript = capture.transcript
  const generated = await generator.fromDictation(transcript)
  const fields = toCardFields(generated)
  // A stale read from before the await is never trusted for a decision that
  // creates something durable: the recording may have been deleted meanwhile.
  if (!db.select({ id: captures.id }).from(captures).where(eq(captures.id, captureId)).get()) return
  const { cardId, duplicateOf } = createCard(
    db,
    { type: 'ru_to_pl', ...fields, status: 'ready', fallbackAnswerKey: answerKey(transcript) },
    now,
  )
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ ...generated, duplicateOf }), error: null })
    .where(eq(captures.id, captureId))
    .run()
}

/** Job `new` gave up: the word is kept as a needs_input card (§6). */
export function giveUpNewCard(db: Db, captureId: string, lastError: string, now: Date): void {
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || capture.cardId || !capture.transcript) return
  const { cardId, duplicateOf } = createCard(
    db,
    { type: 'ru_to_pl', ...strandedFields(capture.transcript), status: 'needs_input' },
    now,
  )
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ duplicateOf }), error: lastError })
    .where(eq(captures.id, captureId))
    .run()
}

/**
 * Job `rerecognized`: rebuilds a card from its recording's new transcript. It
 * rewrites the card in place only when this recording created it (see
 * creatorCaptureId), and on a clash leaves it untouched; otherwise the
 * recording goes through createCard like a new dictation.
 */
export async function applyRerecognized(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture?.transcript) return
  const transcript = capture.transcript
  const generated = await generator.fromDictation(transcript)
  const fields = toCardFields(generated)
  const still = db.select({ cardId: captures.cardId }).from(captures).where(eq(captures.id, captureId)).get()
  if (!still) return
  const existing =
    still.cardId && creatorCaptureId(db, still.cardId) === captureId
      ? db.select().from(cards).where(and(eq(cards.id, still.cardId), isNull(cards.deletedAt))).get()
      : undefined
  const { cardId, duplicateOf } = existing
    ? (({ card, duplicateOf }) => ({ cardId: card.id, duplicateOf }))(
        applyGeneratedFields(db, existing, fields, now, { onClash: 'untouched' }),
      )
    : createCard(db, { type: 'ru_to_pl', ...fields, status: 'ready', fallbackAnswerKey: answerKey(transcript) }, now)
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ ...generated, duplicateOf }), error: null })
    .where(eq(captures.id, captureId))
    .run()
}

/** Job `rerecognized` gave up: the card stays as it was; the failure is recorded (§6). */
export function giveUpRerecognized(db: Db, captureId: string, lastError: string): void {
  db.update(captures).set({ error: lastError }).where(eq(captures.id, captureId)).run()
}

/** The three job kinds (§5), wired to their bodies. */
export function jobHandlers(deps: CaptureDeps): JobHandlers {
  return {
    new: {
      run: (job, now) => generateNewCard(deps, job.captureId!, now),
      giveUp: (job, lastError, now) => giveUpNewCard(deps.db, job.captureId!, lastError, now),
    },
    rerecognized: {
      run: (job, now) => applyRerecognized(deps, job.captureId!, now),
      giveUp: (job, lastError) => giveUpRerecognized(deps.db, job.captureId!, lastError),
    },
    // keepAnswer, approved by the user; a card that stays needs_input on give-up is repairable again.
    regenerate: {
      run: async (job, now) => {
        await regenerateCard(deps.db, deps.generator, job.cardId!, now)
      },
      giveUp: () => {},
    },
  }
}
```

Update the doc comment on `creatorCaptureId` so it names `applyRerecognized` instead of `retranscribe`.

- [ ] **Step 4: Update the routes that called the removed functions**

`app/api/captures/route.ts` — POST: replace the `processCapture` call with

```ts
  // Deliberately not awaited: the phone is told "stored" the moment the bytes
  // are durable, and recognition happens behind it. Generation is not started
  // here at all: it is queued once the recording leaves review.
  void recognizeCapture({ db, transcriber: getTranscriber() }, id, new Date()).catch((err) =>
    console.error('capture recognition failed', id, err),
  )
```

and GET: `return NextResponse.json({ captures: listOnScreen(db, Number.isFinite(since) ? since : 0, new Date()) })`. Remove the `getGenerator` import.

`app/api/captures/[id]/retry/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { recognizeCapture } from '@/lib/capture/pipeline'

/** Retries recognition of a recording whose recognition failed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await recognizeCapture({ db, transcriber: getTranscriber() }, id, new Date())
  return NextResponse.json({ ok: true })
}
```

`app/api/captures/[id]/jezyk/route.ts`: call `rerecognize({ db, transcriber: getTranscriber() }, id, body.data.lang, new Date())` and return its result; replace the comment above that call with:

```ts
  // Speech-to-Text failures come back in `error` as a 200 — the recording
  // keeps its transcript. With a card, `queued` says the Gemini half is now
  // waiting in the generation queue.
```

Remove the `getGenerator` import.

`app/fiszki/[id]/page.tsx` — in `relanguage`, replace the success branch (the `const body = … as { duplicateOf… }` through `await load()`) with:

```tsx
      const body = (await res.json()) as { queued: boolean; error: string | null }
      setLangError(body.error !== null)
      await load()
```

and update the comment above `relanguage` that says the route answers with the provider failure "since the capture keeps its old transcript and card either way" so it says: the route answers 200 with a Speech-to-Text failure in `error`, and with `queued: true` when the card's regeneration is now waiting in the generation queue. (Task 10 adds the `generowanie…` state.)

- [ ] **Step 5: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: recognition runs now; card generation becomes queue jobs

processCapture and retranscribe split into a synchronous recognition half
(recognizeCapture, rerecognize: Speech-to-Text, the review window, the
recognition-time już masz) and queued job bodies (generateNewCard,
applyRerecognized, regenerateCard). listOnScreen shows only what the review
rule keeps on screen. No HTTP handler calls Gemini for a recording any more."
```

---

### Task 6: The worker

**Files:**
- Create: `lib/queue/worker.ts`, `lib/queue/worker.test.ts`, `instrumentation.ts`, `instrumentation.test.ts`

**Interfaces:**
- Consumes: `promoteApproved`, `recoverRunning`, `runNextJob`, `RunnerState`, `RunOutcome` (Task 4); `jobHandlers`, `CaptureDeps` (Task 5).
- Produces: `TICK_MS = 1_000`; `tick(deps: CaptureDeps, state: RunnerState, now: Date, random: () => number): Promise<RunOutcome>`; `startWorker(): Promise<void>`; `instrumentation.ts` `register()`.

- [ ] **Step 1: Write the failing tests**

`lib/queue/worker.test.ts` — end to end through real handlers with a fake generator:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/testing'
import { cards, captures } from '../db/schema'
import { GenerationError, type GeneratedCard } from '../generate'
import { createCapture, recognizeCapture } from '../capture/pipeline'
import { tick } from './worker'

const NOW = new Date('2026-09-18T10:00:00')
const later = (ms: number) => new Date(NOW.getTime() + ms)
const GENERATED: GeneratedCard = {
  answer_pl: 'kot', prompt_ru: 'кот', prompt_hint: '', example_pl: '', example_ru: '', grammar_note: '',
  kind: 'rzeczownik', forms_basic: [{ label: 'M. l.mn.', value: 'koty' }], forms_extended: [],
}

function deps(fromDictation = vi.fn().mockResolvedValue(GENERATED)) {
  const { db } = createTestDb()
  return { db, transcriber: { transcribe: vi.fn().mockResolvedValue('kot') }, generator: { fromDictation } }
}

async function dictate(d: ReturnType<typeof deps>) {
  const id = createCapture(d.db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, NOW)
  await recognizeCapture(d, id, NOW)
  return id
}

describe('tick', () => {
  it('turns an approved recording into a card', async () => {
    const d = deps()
    await dictate(d)
    expect(await tick(d as never, { pausedUntil: 0 }, later(9_999), () => 0)).toBe('idle')
    expect(await tick(d as never, { pausedUntil: 0 }, later(10_000), () => 0)).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(captures).get()!.status).toBe('generated')
  })

  it('waits out a 429 and then succeeds', async () => {
    const d = deps(vi.fn().mockRejectedValueOnce(new GenerationError('429', { retryable: true })).mockResolvedValue(GENERATED))
    await dictate(d)
    const state = { pausedUntil: 0 }
    expect(await tick(d as never, state, later(10_000), () => 0)).toBe('retry')
    expect(await tick(d as never, state, later(11_000), () => 0)).toBe('paused')
    expect(await tick(d as never, state, new Date(state.pausedUntil), () => 0)).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
  })

  it('never generates a rejected recording', async () => {
    const d = deps()
    const id = await dictate(d)
    d.db.delete(captures).run()
    await tick(d as never, { pausedUntil: 0 }, later(10_000), () => 0)
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
    expect(id).toBeTruthy()
  })
})
```

`instrumentation.test.ts` (repo root):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const startWorker = vi.fn()
vi.mock('./lib/queue/worker', () => ({ startWorker }))
const { register } = await import('./instrumentation')

afterEach(() => {
  startWorker.mockClear()
  vi.unstubAllEnvs()
})

describe('register', () => {
  it('starts the worker in the Node.js server runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    await register()
    expect(startWorker).toHaveBeenCalledTimes(1)
  })

  it('does not start it in the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    await register()
    expect(startWorker).not.toHaveBeenCalled()
  })

  it('does not start it during next build', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    await register()
    expect(startWorker).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run lib/queue/worker.test.ts instrumentation.test.ts`
Expected: neither module exists.

- [ ] **Step 3: Implement**

`lib/queue/worker.ts`:

```ts
import { jobHandlers, type CaptureDeps } from '../capture/pipeline'
import { promoteApproved, recoverRunning, runNextJob, type RunnerState, type RunOutcome } from './jobs'

export const TICK_MS = 1_000

/** One pass (spec 2026-09-18-generation-queue §5): promote approved recordings, then run at most one due job. */
export async function tick(deps: CaptureDeps, state: RunnerState, now: Date, random: () => number): Promise<RunOutcome> {
  promoteApproved(deps.db, now)
  return runNextJob(deps.db, jobHandlers(deps), state, now, random)
}

declare global {
  var __fiszkiGenerationWorker: boolean | undefined
}

/**
 * Starts the loop once per server process. The providers are built lazily and
 * rebuilt after a failure, so a missing FISZKI_MODEL at boot is logged on every
 * tick instead of killing the worker for the life of the process. Ticks never
 * overlap: a slow Gemini call simply delays the next one.
 */
export async function startWorker(): Promise<void> {
  if (globalThis.__fiszkiGenerationWorker) return
  globalThis.__fiszkiGenerationWorker = true
  const { db } = await import('../db/client')
  const { getTranscriber } = await import('../transcribe')
  const { getGenerator } = await import('../generate')
  console.log(`generation worker started (recovered ${recoverRunning(db)} interrupted job(s))`)
  const state: RunnerState = { pausedUntil: 0 }
  let deps: CaptureDeps | null = null
  let busy = false
  setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        deps ??= { db, transcriber: getTranscriber(), generator: getGenerator() }
        await tick(deps, state, new Date(), Math.random)
      } catch (err) {
        deps = null
        console.error('generation worker tick failed', err)
      } finally {
        busy = false
      }
    })()
  }, TICK_MS)
}
```

`instrumentation.ts`:

```ts
/**
 * Next.js calls this once when a server instance starts. The generation queue
 * (spec 2026-09-18-generation-queue §5) runs inside the web server, only in the
 * Node.js runtime, and never during `next build`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { startWorker } = await import('./lib/queue/worker')
  await startWorker()
}
```

- [ ] **Step 4: Confirm the worker really starts under `next start`**

`npm run build`, then run `FISZKI_DB=/tmp/fiszki-worker-check.db npx next start -p 3999` in the background for ~8 seconds, and confirm its output contains `generation worker started`. Stop it and remove `/tmp/fiszki-worker-check.db*`. If the line does not appear, Next is not calling `register()` in this setup — stop and report BLOCKED with what you observed; do not work around it.

- [ ] **Step 5: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: the generation worker runs inside the web server

Started once from instrumentation.ts in the Node.js runtime (never during
next build). Each second it promotes approved recordings and runs at most one
due job; ticks never overlap, and interrupted jobs are recovered at boot."
```

---

### Task 7: Card routes for the queue

**Files:**
- Modify: `app/api/cards/[id]/regeneruj/route.ts`, `app/api/cards/route.ts`, `app/api/cards/[id]/route.ts` and their tests

**Interfaces:**
- Consumes: `enqueueJob`, `hasActiveJob`, `activeJobCardIds` (Task 4); `pendingCaptures` (Task 5).
- Produces: `POST /api/cards/:id/regeneruj` → `202 { queued: true }` | `400` | `404`; `GET /api/cards` → `{ cards, pending, generatingCardIds }`; `GET /api/cards/:id` → `{ card, captureId, generating }`.

- [ ] **Step 1: Write the failing tests**

Replace `app/api/cards/[id]/regeneruj/route.test.ts`'s tests (it no longer calls Gemini, so drop its `@/lib/generate` mock) with:

```ts
describe('POST /api/cards/:id/regeneruj', () => {
  it('queues a regenerate job and answers 202 at once', async () => {
    seedStranded('c1')
    const res = await post('c1')
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: true })
    const jobs = db.select().from(generationJobs).all()
    expect(jobs).toEqual([expect.objectContaining({ kind: 'regenerate', cardId: 'c1', status: 'queued' })])
  })

  it('does not queue a second job while one is waiting', async () => {
    seedStranded('c2')
    await post('c2')
    await post('c2')
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('refuses a card that is not needs_input', async () => {
    seedStranded('c3')
    db.update(cards).set({ status: 'ready' }).where(eq(cards.id, 'c3')).run()
    expect((await post('c3')).status).toBe(400)
  })

  it('answers 404 for an unknown card', async () => {
    expect((await post('nope')).status).toBe(404)
  })
})
```

(`beforeEach` must also clear `generationJobs` before `cards`.) In `app/api/cards/route.test.ts` add a test that `GET` returns `pending` (a `queued` capture seeded directly) and `generatingCardIds` (a card with a queued `regenerate` job); in `app/api/cards/[id]/route.test.ts` add that `generating` is `true` with a queued job for the card and `false` without.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run app/api/cards`
Expected: regeneruj answers 200 by calling Gemini; GET has no `pending`/`generating`.

- [ ] **Step 3: Implement**

`app/api/cards/[id]/regeneruj/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { enqueueJob, hasActiveJob } from '@/lib/queue/jobs'

/**
 * Queues `wygeneruj ponownie` (spec 2026-09-18-generation-queue §5) and answers
 * at once. Gemini is called by the generation queue, which retries 429s with
 * backoff; calling it here would hold this request open for as long as that
 * takes. regenerateCard re-checks needs_input when the job runs.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const card = db.select().from(cards).where(and(eq(cards.id, id), isNull(cards.deletedAt))).get()
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (card.status !== 'needs_input') {
    return NextResponse.json({ error: 'only a needs_input card can be regenerated' }, { status: 400 })
  }
  if (!hasActiveJob(db, id)) enqueueJob(db, { kind: 'regenerate', cardId: id }, new Date())
  return NextResponse.json({ queued: true }, { status: 202 })
}
```

`app/api/cards/route.ts` GET:

```ts
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? ''
  return NextResponse.json({
    cards: searchCards(db, q),
    // Words approved and waiting for, or in, generation (§7.2), and cards
    // with a regeneration in flight — both shown as not-yet-final.
    pending: pendingCaptures(db),
    generatingCardIds: activeJobCardIds(db),
  })
}
```

`app/api/cards/[id]/route.ts` GET: return `{ card, captureId: creatorCaptureId(db, id), generating: hasActiveJob(db, id) }`, and update the comment above it: it currently says re-recognising a later duplicate's audio "would build that recording its own card"; make it say that recording would go through `createCard` (a new card, or an existing one via dedup), and add that `generating` tells the page a queued job will rewrite this card.

- [ ] **Step 4: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: wygeneruj ponownie is queued; card routes report pending work

regeneruj answers 202 and queues a job instead of calling Gemini inside the
request. GET /api/cards lists words waiting for generation and cards being
regenerated; GET /api/cards/:id says whether a job will rewrite the card."
```

---

### Task 8: The recording screen

**Files:**
- Modify: `components/CaptureChip.tsx`, `components/CaptureChip.dom.test.tsx`, `app/dodaj/page.tsx`, `app/dodaj/page.dom.test.tsx`, `lib/capture/pipeline.ts` (trim `CaptureView`), `i18n/pl.ts`, `i18n/pl.test.ts`

**Interfaces:**
- Consumes: `CaptureView` with `inReview`, `reviewRemainingMs`, `duplicateOf` (Task 5); `REVIEW_MS` (Task 3).
- Produces: `CaptureView = { id; status; transcript; error; duplicateOf; createdAt; inReview; reviewRemainingMs }` (the other fields go, and `listOnScreen` stops selecting them); `CaptureChip` props `{ item, onRetry, onDelete, onRelanguage, pending? }`.

- [ ] **Step 1: Write the failing tests**

Rewrite `components/CaptureChip.dom.test.tsx`. Keep the `swipe` helper and every swipe/`usuń` test. Delete the tests for the audio player, the type switch, the tap-to-edit form and the form's stale-field reset. `captureItem()` becomes:

```tsx
function captureItem(over: Partial<CaptureView> = {}): ChipItem {
  return {
    kind: 'capture',
    capture: {
      id: 'cap-1', status: 'transcribed', transcript: 'kot', error: null, duplicateOf: null,
      createdAt: 1, inReview: true, reviewRemainingMs: 6_000, ...over,
    },
  }
}
```

Add:

```tsx
  it('shows no audio player — the chip is status only', () => {
    const { container } = render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(container.querySelector('audio')).toBeNull()
  })

  it('offers re-recognition while under review', () => {
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(screen.getByText(t.asRussian)).toBeTruthy()
  })

  it('offers ponów, not re-recognition, when recognition failed', () => {
    render(
      <CaptureChip
        item={captureItem({ status: 'failed', transcript: null, error: 'unintelligible', inReview: false, reviewRemainingMs: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()}
      />,
    )
    expect(screen.getByText(t.retry)).toBeTruthy()
    expect(screen.queryByText(t.asRussian)).toBeNull()
    expect(screen.getByText('unintelligible')).toBeTruthy()
  })

  it('says już masz for a word already in the deck', () => {
    render(<CaptureChip item={captureItem({ duplicateOf: 'card-9' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(screen.getByText(t.alreadyHave)).toBeTruthy()
  })

  // The bar is cosmetic — the server decides — but it must track what the
  // server says is left, so the fade never looks like a glitch.
  it('draws the review bar from the server-computed remaining time', () => {
    const { container } = render(
      <CaptureChip item={captureItem({ reviewRemainingMs: 2_500 })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />,
    )
    const bar = container.querySelector('[data-review-bar]') as HTMLElement
    expect(bar.style.width).toBe('25%')
  })

  it('shows rozpoznawanie… while recognition runs', () => {
    render(
      <CaptureChip
        item={captureItem({ status: 'uploaded', transcript: null, inReview: false, reviewRemainingMs: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()}
      />,
    )
    expect(screen.getByText(t.transcribing)).toBeTruthy()
  })
```

In `app/dodaj/page.dom.test.tsx`: update `captureRow()` to the new `CaptureView` shape (`inReview` true for `'transcribed'`, `reviewRemainingMs` 5000 for it, null otherwise); delete the type-switch tests and their notices; make every delete assertion expect `DELETE /api/captures/<id>` (on-screen recordings never have a card). Add:

```tsx
  // The fade is data-driven: a recording leaves the screen when the server
  // stops returning it (it was approved), not on a client timer.
  it('drops a recording once the server stops returning it', async () => {
    stubMic()
    let list: CaptureView[] = [captureRow('cap-1', 'transcribed')]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ captures: list }) }) as unknown as Promise<Response>))
    render(<AddPage />)
    expect(await screen.findByText(t.asRussian)).toBeTruthy()
    list = []
    await waitFor(() => expect(screen.queryByText(t.asRussian)).toBeNull(), { timeout: 3_000 })
  })
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run components/CaptureChip.dom.test.tsx app/dodaj/page.dom.test.tsx`
Expected: the chip still renders `<audio>`, has no `data-review-bar`, and takes `onSetType`.

- [ ] **Step 3: Rewrite `components/CaptureChip.tsx`**

Keep the file's `ChipItem`, `chipKey`, `chipCreatedAt`, `SWIPE_THRESHOLD_PX` and their comments. Replace the component with:

```tsx
export function CaptureChip({
  item,
  onRetry,
  onDelete,
  onRelanguage,
  pending = false,
}: {
  item: ChipItem
  onRetry: (id: string) => void
  onDelete: (item: ChipItem) => void
  onRelanguage: (id: string, lang: DictationLang) => void
  /** A re-recognition for this recording is in flight; its controls are disabled until it lands. */
  pending?: boolean
}) {
  // A ref, not state: bookkeeping between one pointerdown and the pointerup
  // after it, read synchronously with no render in between. Declared before
  // the outbox return, since hook count may not vary between renders.
  const pointerStartX = useRef<number | null>(null)

  if (item.kind === 'outbox') {
    // No server row yet, so nothing to retry, re-recognise or delete.
    return (
      <li className="flex items-center gap-3 border-b py-3">
        <p className="flex-1 text-lg text-neutral-500">{t.uploading}</p>
      </li>
    )
  }

  const capture = item.capture
  // Every control stops its own pointer events, or the <li> would read the
  // press as a swipe as well.
  const own = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
  }

  function onPointerDown(e: React.PointerEvent) {
    pointerStartX.current = e.clientX
  }

  function onPointerUp(e: React.PointerEvent) {
    if (pointerStartX.current === null) return
    const dx = e.clientX - pointerStartX.current
    pointerStartX.current = null
    if (dx <= -SWIPE_THRESHOLD_PX) onDelete(item)
  }

  return (
    <li className="flex flex-col gap-2 border-b py-3" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-lg">{capture.transcript ?? t.transcribing}</p>
          {capture.duplicateOf && <p className="text-sm text-amber-600">{t.alreadyHave}</p>}
          {capture.error && <p className="text-sm text-red-600">{capture.error}</p>}
        </div>
        {capture.status === 'failed' && (
          <button onClick={() => onRetry(capture.id)} {...own} className="text-sm underline">
            {t.retry}
          </button>
        )}
      </div>

      {/* Recognition is Polish by default; a two-language recognizer
          demonstrably swallows Russian (spoken "склеп" came back "sklep"), so a
          Russian recording is re-recognised here, from its stored audio, while
          it is still under review — which restarts the 10 s. */}
      {capture.inReview && (
        <div className="flex items-center gap-3 pl-2 text-sm">
          <span className="text-neutral-500">{t.recognizeAs}</span>
          {([
            ['pl', t.asPolish],
            ['ru', t.asRussian],
          ] as const).map(([lang, label]) => (
            <button
              key={lang}
              onClick={() => onRelanguage(capture.id, lang)}
              {...own}
              disabled={pending}
              className="underline disabled:text-neutral-400"
            >
              {label}
            </button>
          ))}
          {pending && <span className="text-neutral-500">{t.transcribing}</span>}
        </div>
      )}

      <button onClick={() => onDelete(item)} {...own} className="self-end text-sm text-red-600 underline">
        {t.deleteItem}
      </button>

      {/* The review window (spec 2026-09-18-generation-queue §3). Cosmetic:
          the server decides approval; this only shows what it says is left,
          stepping each poll and gliding between steps. */}
      {capture.inReview && capture.reviewRemainingMs !== null && (
        <div className="h-0.5 w-full bg-neutral-200" aria-hidden="true">
          <div
            data-review-bar
            className="h-full bg-neutral-500"
            style={{ width: `${(capture.reviewRemainingMs / REVIEW_MS) * 100}%`, transition: 'width 1s linear' }}
          />
        </div>
      )}
    </li>
  )
}
```

Imports become: `useRef` from react; `CaptureView` from pipeline; `DictationLang` from transcribe; `REVIEW_MS` from `@/lib/queue/review`; `t`. Remove the `useState`, `CardType`, `hasForms` and `CardTypeSwitch` imports and the `EditableFields` type. Update the file's top doc comment where it mentions swipe-to-delete/tap-to-edit so it describes only what the chip now does.

- [ ] **Step 4: Update `app/dodaj/page.tsx` and `CaptureView`**

- Delete `setType`, the `CardType` import, and the `typeFailed`/`typeDuplicate` members of `Notice` and `NOTICE_TEXT`.
- `deleteChip`: always `DELETE /api/captures/${capture.id}`; replace its comment with one saying an on-screen recording never has a card (it is uploaded, failed or under review), so rejecting it deletes the recording.
- `hasPending`: `outboxItems.length > 0 || captures.some((c) => c.status === 'uploaded' || c.inReview)`, and update the comment above it: polling runs while anything is uploading, recognising or under review, since a recording under review leaves the screen only when the server stops returning it.
- The notice's colour condition: `text-red-600` for every remaining notice.
- `<CaptureChip … />`: drop `onSetType`.
- In `lib/capture/pipeline.ts`, trim `CaptureView` to `{ id, status, transcript, error, duplicateOf, createdAt, inReview, reviewRemainingMs }` and stop selecting `cardId`, `audioMediaId`, `cardType`, `wordKind` in `listOnScreen` (drop the `cards` join there).
- `i18n/pl.ts`: remove `save` and `chipSaveFailed` if `grep -rn "t\.save\b\|t\.chipSaveFailed" app components` finds no other use, and update `i18n/pl.test.ts`'s required keys to match.

- [ ] **Step 5: Run the gates, the /dodaj file 5 times, then commit**

```bash
git add -A
git commit -m "feat: the recording screen shows recent recordings and their status

No player, no type switch, no edit form. A transcript under review offers
po polsku / po rosyjsku and usuń with a bar draining to approval; a failed
recognition offers ponów. A recording leaves the screen when the server
stops returning it."
```

---

### Task 9: Waiting words on `/fiszki`

**Files:**
- Modify: `app/fiszki/page.tsx`, `app/fiszki/page.dom.test.tsx`, `i18n/pl.ts`

**Interfaces:**
- Consumes: `GET /api/cards` → `{ cards, pending, generatingCardIds }` (Task 7).

- [ ] **Step 1: Add the strings**

`i18n/pl.ts`, after `regenerateDuplicate`:

```ts
  queued: 'w kolejce',
  generating: 'generowanie…',
```

Add `'queued'` and `'generating'` to the required keys in `i18n/pl.test.ts`, if it lists them.

- [ ] **Step 2: Write the failing tests**

Change the list test's `stubFetch(rows)` so the response is `{ cards: rows(), pending: [], generatingCardIds: [] }`, and add a stub variant taking `pending` and `generatingCardIds`. Add:

```tsx
  it('lists words waiting for generation above the cards, badged', async () => {
    stubFetch(() => [cardRow({ answerPl: 'kot' })], {
      pending: [
        { id: 'p1', transcript: 'zdrów jak ryba', status: 'generating' },
        { id: 'p2', transcript: 'wścieklizna', status: 'queued' },
      ],
    })
    render(<CardsPage />)
    const items = await screen.findAllByRole('listitem')
    expect(items[0].textContent).toContain('zdrów jak ryba')
    expect(items[0].textContent).toContain(t.generating)
    expect(items[1].textContent).toContain(t.queued)
    expect(items[2].textContent).toContain('kot')
    expect(items[0].querySelector('a')).toBeNull()
  })

  it('badges a card that is being regenerated', async () => {
    stubFetch(() => [cardRow({ id: 'c1', answerPl: 'kot' })], { generatingCardIds: ['c1'] })
    render(<CardsPage />)
    const row = (await screen.findByText('kot')).closest('li')!
    expect(row.textContent).toContain(t.generating)
  })

  it('filters waiting words by the search, like cards', async () => {
    stubFetch(() => [], { pending: [{ id: 'p1', transcript: 'wścieklizna', status: 'queued' }] })
    render(<CardsPage />)
    await screen.findByText('wścieklizna')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'kot' } })
    await waitFor(() => expect(screen.queryByText('wścieklizna')).toBeNull())
  })
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run app/fiszki/page.dom.test.tsx`

- [ ] **Step 4: Implement**

In `app/fiszki/page.tsx`:

```tsx
type PendingRow = { id: string; transcript: string | null; status: 'queued' | 'generating' }
```

State: `const [pending, setPending] = useState<PendingRow[]>([])` and `const [generatingIds, setGeneratingIds] = useState<ReadonlySet<string>>(() => new Set())`. `load` sets all three from `{ cards, pending, generatingCardIds }`. Add polling:

```tsx
  // Words waiting for generation turn into cards on their own (spec
  // 2026-09-18-generation-queue §7.2); poll while anything is still waiting.
  const waiting = pending.length > 0 || generatingIds.size > 0
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => void load(q), 2_000)
    return () => clearInterval(id)
  }, [waiting, q, load])
```

Render, first inside the `<ul>`, the pending rows filtered by the query (`(p.transcript ?? '').toLowerCase().includes(q.trim().toLowerCase())`):

```tsx
          <li key={`pending:${p.id}`} className="flex items-baseline justify-between gap-3 border-b py-3 text-neutral-500">
            <span className="text-lg">{p.transcript}</span>
            <span className="shrink-0 text-xs">{p.status === 'generating' ? t.generating : t.queued}</span>
          </li>
```

and in each card row's badge span add `{generatingIds.has(c.id) && <span className="text-sky-700">{t.generating}</span>}`. Update the file's top doc comment to mention the waiting rows.

- [ ] **Step 5: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: words waiting for generation are listed on top of /fiszki"
```

---

### Task 10: Queued actions on the card page

**Files:**
- Modify: `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`

**Interfaces:**
- Consumes: `GET /api/cards/:id` → `generating` (Task 7); `POST …/regeneruj` → 202 (Task 7); `POST /api/captures/:id/jezyk` → `{ queued, error }` (Task 5).

- [ ] **Step 1: Write the failing tests**

Update this file's `stubFetch` so GET returns `{ card, captureId, generating: false }` by default. Replace the regenerate tests that expect an immediate repaired card or a duplicate notice with:

```tsx
  it('queues wygeneruj ponownie and shows generowanie… until the card is rebuilt', async () => {
    let generating = false
    let card = cardRow({ status: 'needs_input', promptText: null })
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        generating = true
        return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ queued: true }) }) as unknown as Promise<Response>
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ card, captureId: null, generating }) }) as unknown as Promise<Response>
    }))
    render(<CardPage />)
    const button = await screen.findByText(t.regenerate)
    await act(async () => { fireEvent.click(button) })
    expect(await screen.findByText(t.generating)).toBeTruthy()

    card = cardRow({ status: 'ready', promptText: 'злобный' })
    generating = false
    expect(await screen.findByDisplayValue('злобный', undefined, { timeout: 4_000 })).toBeTruthy()
    expect(screen.queryByText(t.generating)).toBeNull()
  })

  it('disables the generating controls while a job is in flight', async () => {
    stubFetch(() => cardRow({ status: 'needs_input', promptText: null }), 'cap-1', true)
    render(<CardPage />)
    expect(await screen.findByText(t.generating)).toBeTruthy()
    expect((screen.getByText(t.asRussian) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows generowanie… after a re-recognition queues the rebuild', async () => {
    let generating = false
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        generating = true
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ queued: true, error: null }) }) as unknown as Promise<Response>
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ card: cardRow(), captureId: 'cap-1', generating }) }) as unknown as Promise<Response>
    }))
    render(<CardPage />)
    const button = await screen.findByText(t.asRussian)
    await act(async () => { fireEvent.click(button) })
    expect(await screen.findByText(t.generating)).toBeTruthy()
  })
```

(`stubFetch(card, captureId = 'cap-1', generating = false)` gains the third parameter.) Keep the existing Speech-to-Text failure test (`error` in a 200 shows `t.languageFailed`) with the new response shape `{ queued: false, error: '…' }`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run "app/fiszki/[id]/page.dom.test.tsx"`

- [ ] **Step 3: Implement**

In `app/fiszki/[id]/page.tsx`:

- State: `const [generating, setGenerating] = useState(false)`; `load` also does `setGenerating(body.generating ?? false)` (type the body `{ card: CardRow; captureId?: string | null; generating?: boolean }`).
- Poll while generating:

```tsx
  // A queued job will rewrite this card (spec 2026-09-18-generation-queue
  // §7.3); reload until it has. The inputs are keyed on server values, so the
  // rebuilt text replaces what is on screen and nothing stale is saved back.
  useEffect(() => {
    if (!generating) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [generating, load])
```

- `regenerate()`:

```tsx
  async function regenerate() {
    const res = await fetch(`/api/cards/${id}/regeneruj`, { method: 'POST' })
    if (!res.ok) {
      setRegenError(true)
      return
    }
    setRegenError(false)
    setGenerating(true)
  }
```

- `relanguage()` success branch: `setLangError(body.error !== null); if (body.queued) setGenerating(true); else await load()`.
- Disable the `wygeneruj ponownie` button and both language buttons when `generating || langPending`; next to the language buttons, show `{generating && <span className="text-neutral-500">{t.generating}</span>}`.
- Remove `regenDuplicate` state, its setter calls and its paragraph: the regeneration's outcome now arrives later, through the reloaded card.
- Update the comments on `regenerate` and `relanguage` to say both now queue the Gemini half and return at once.

- [ ] **Step 4: Run the gates, then commit**

```bash
git add -A
git commit -m "feat: the card page queues regeneration and shows generowanie…

wygeneruj ponownie and re-recognition return at once; the page disables
those controls, polls, and shows the rebuilt card when its job finishes."
```

---

### Task 11: Deploy and verify (controller-only)

Done by the controller, not delegated. Deploy facts are in memory (`fiszki-vm-deployment`). **This deploy keeps the database** — it holds real cards.

- [ ] **Step 1: Gates on the finished branch** — all three clean.
- [ ] **Step 2: Back up first.** `systemctl start fiszki-backup.service` on the VM, and confirm a new object in `gs://project-31c40f90-c32c-447c-b5e-fiszki-backups/`.
- [ ] **Step 3: Fresh-tree swap, detached** (as last time, minus moving the database): extract to `/opt/fiszki.new`, `npm ci`, `npm run build` while the old app serves; abort if stale files exist; then stop, swap, chown, start. Run it with `setsid nohup` and poll its log.
- [ ] **Step 4: Verify.** `_migrations` lists `001-init.sql` and `002-generation-queue.sql`; `PRAGMA table_info(generation_jobs)` exists; card count unchanged from before the deploy; `journalctl -u fiszki` shows `generation worker started`; `npm run check-providers` passes.
- [ ] **Step 5: End to end on the VM, without the phone.** A script on the VM: log in; synthesize `kot` with the TTS module; `POST /api/captures` it as multipart; poll `GET /api/captures` and see it `inReview` with `reviewRemainingMs` falling; after ~11 s see it gone from `/api/captures` and present in `/api/cards` `pending`; within the next ticks see a `kot` card (or, if `kot` already exists, the recording `duplicate` and no new card). Repeat with a second recording and `DELETE` it inside the window: it never appears in `pending` or as a card.
- [ ] **Step 6: On the phone.** Ask the user to dictate several words in a row and reject one.
- [ ] **Step 7: Update memory** with the deploy date and anything the deploy taught.
