# Recording Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/dodaj` records with two hold buttons, PL and RU. The chosen language is stored with the recording and used for every recognition of it. Re-recognition is removed everywhere.

**Architecture:** A nullable `captures.lang` (migration 004) is written at upload and read by `recognizeCapture`. The outbox and the upload carry `lang`. Everything that existed only for re-recognition is deleted end to end: the `jezyk` route, `rerecognize`, the `rerecognized` job kind, `creatorCaptureId`, and the chip and card-page controls.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, SQLite (better-sqlite3) + Drizzle, hand-written SQL migrations, Vitest + jsdom, idb-keyval outbox, Google Speech-to-Text v2.

**Spec:** `docs/superpowers/specs/2026-09-18-recording-language-design.md`. Read it before any task. Where this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- **Every task passes three gates before it commits:** `npx tsc --noEmit` prints nothing, `npx vitest run` is all green, and `npm run build` exits 0. Read each gate's output before committing. Never chain a commit after a test command with `&&`.
- **Test first.** Every behaviour change has a test you watched fail for the stated reason before the code existed. Removals are the exception: delete the code and its tests together, and show the gates green.
- **Every comment must be true when committed.** That includes comments your change makes false in files you touch; many comments about "Polish by default" and re-recognition become false here.
- **Migrations are append-only.** This plan adds exactly one, `migrations/004-capture-lang.sql`. Never edit 001–003. The deployed database holds real cards.
- **Languages:** exactly `'pl' | 'ru'` (`DictationLang` in `lib/transcribe/index.ts`). A stored null means `pl`, and a missing upload field means `pl`.
- **Job kinds after this plan:** `new | regenerate | suggest`.
- **All UI strings live in `i18n/pl.ts`, in Polish, with no Cyrillic.** `asPolish`/`asRussian` stay because `/tematy/nowy` uses them.
- **Do not change `FISZKI_MODEL`.**
- `app/dodaj/page.dom.test.tsx` is intermittently flaky. If it alone fails, re-run it and report both runs.

## File map

| File | Responsibility | Task |
|---|---|---|
| `migrations/004-capture-lang.sql` (new), `lib/db/schema.ts`, `lib/db/schema-shape.test.ts` | `captures.lang`; fail stranded `rerecognized` jobs | 1 |
| `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `app/api/captures/route.ts`, `app/api/captures/route.test.ts` (new) | recognition uses the stored language; the upload takes `lang` | 2 |
| `lib/capture/pipeline.ts`, `lib/queue/jobs.ts`, `lib/db/schema.ts`, `app/api/captures/[id]/jezyk/*` (deleted), `app/api/cards/[id]/route.ts`, their tests | remove server-side re-recognition | 3 |
| `lib/capture/outbox.ts`, `app/dodaj/page.tsx`, `components/CaptureChip.tsx`, `app/fiszki/[id]/page.tsx`, `i18n/pl.ts`, their tests | two buttons; no language controls | 4 |

---

### Task 1: Migration 004 and schema

**Files:**
- Create: `migrations/004-capture-lang.sql`
- Modify: `lib/db/schema.ts`, `lib/db/schema-shape.test.ts`

**Interfaces:**
- Produces: `captures.lang: 'pl' | 'ru' | null` in Drizzle.

- [ ] **Step 1: Failing tests.** In `lib/db/schema-shape.test.ts`, extend the migration-list expectation to `['001-init.sql', '002-generation-queue.sql', '003-topics.sql', '004-capture-lang.sql']`, then add:

```ts
  it('gives captures a recognition language', () => {
    const { sqlite } = createTestDb()
    const cols = (sqlite.prepare('PRAGMA table_info(captures)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('lang')
  })

  // Re-recognition is removed (spec 2026-09-18-recording-language §4): a
  // `rerecognized` job still waiting at upgrade time would reach a worker with
  // no handler for it. Finished ones stay as history.
  it('fails queued and running rerecognized jobs on upgrade, leaving the rest', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    for (const f of ['001-init.sql', '002-generation-queue.sql', '003-topics.sql']) {
      sqlite.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'))
    }
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    sqlite.prepare(`INSERT INTO _migrations VALUES ('001-init.sql', 1), ('002-generation-queue.sql', 1), ('003-topics.sql', 1)`).run()
    const job = sqlite.prepare(`INSERT INTO generation_jobs (id, kind, status, next_attempt_at, created_at) VALUES (?, ?, ?, 1, 1)`)
    job.run('q', 'rerecognized', 'queued')
    job.run('r', 'rerecognized', 'running')
    job.run('d', 'rerecognized', 'done')
    job.run('n', 'new', 'queued')
    sqlite.prepare(`INSERT INTO captures (id, status, created_at) VALUES ('c1', 'generated', 1)`).run()

    migrate(sqlite)

    const rows = sqlite.prepare(`SELECT id, status, last_error, finished_at IS NOT NULL AS finished FROM generation_jobs ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 'd', status: 'done', last_error: null, finished: 0 },
      { id: 'n', status: 'queued', last_error: null, finished: 0 },
      { id: 'q', status: 'failed', last_error: 're-recognition removed', finished: 1 },
      { id: 'r', status: 'failed', last_error: 're-recognition removed', finished: 1 },
    ])
    expect(sqlite.prepare(`SELECT lang FROM captures`).get()).toEqual({ lang: null })
  })
```

- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run lib/db`. It should fail because there is no `004-capture-lang.sql` and no `lang` column.

- [ ] **Step 3: The migration.** Create `migrations/004-capture-lang.sql`:

```sql
-- Recording language (docs/superpowers/specs/2026-09-18-recording-language-design.md §4).
-- Append-only: the deployed database holds real cards.

-- The language the recording was made in, chosen by the button held on /dodaj:
-- 'pl' | 'ru'. NULL for every recording made before this migration, which
-- were all recognised as Polish, so NULL means 'pl'.
ALTER TABLE captures ADD COLUMN lang TEXT;

-- Re-recognition is removed along with its 'rerecognized' job kind. A job of
-- that kind still waiting or running would reach a worker with no handler
-- for it, so it ends here. Finished ones stay as history.
UPDATE generation_jobs
   SET status = 'failed',
       last_error = 're-recognition removed',
       finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE kind = 'rerecognized' AND status IN ('queued', 'running');
```

- [ ] **Step 4: Drizzle.** In `lib/db/schema.ts`, add `lang: text('lang', { enum: ['pl', 'ru'] }),` as the last field of `captures`. Leave `generationJobs.kind` alone; Task 3 changes it.
- [ ] **Step 5: Run the tests.** `npx vitest run lib/db` should pass.
- [ ] **Step 6: Gates, then commit.**

```bash
git add migrations/004-capture-lang.sql lib/db/schema.ts lib/db/schema-shape.test.ts
git commit -m "feat: migration 004 — a recording's language"
```

---

### Task 2: Recognition in the recording's language

**Files:**
- Modify: `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `app/api/captures/route.ts`
- Create: `app/api/captures/route.test.ts`

**Interfaces:**
- Consumes: `captures.lang` (Task 1).
- Produces: `createCapture(db, audio: { bytes; mime }, now: Date, lang: DictationLang = 'pl'): string`. `recognizeCapture` transcribes with `lang: capture.lang ?? 'pl'`. `POST /api/captures` reads multipart `lang`: `pl`, `ru`, or absent (meaning `pl`); anything else gets a 400.

- [ ] **Step 1: Failing pipeline tests.** Append to `lib/capture/pipeline.test.ts`, which already has `deps()`, `AUDIO`, `NOW` and `row(d, id)`:

```ts
describe('recognition language (spec 2026-09-18-recording-language §2)', () => {
  it('stores the language the recording was made in', () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    expect(row(d, id).lang).toBe('ru')
  })

  it('stores pl when no language is given', () => {
    const d = deps()
    expect(row(d, createCapture(d.db, AUDIO, NOW)).lang).toBe('pl')
  })

  it('recognises in the stored language', async () => {
    const d = deps()
    const ru = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeCapture(d, ru)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))
    const pl = createCapture(d.db, AUDIO, NOW, 'pl')
    await recognizeCapture(d, pl)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'pl' }))
  })

  it('recognises an older recording, with no stored language, as Polish', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    d.db.update(captures).set({ lang: null }).where(eq(captures.id, id)).run()
    await recognizeCapture(d, id)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'pl' }))
  })

  it('keeps the language when a failed recognition is retried, and after a restart', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('склеп') } })
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeCapture(d, id)
    expect(row(d, id).status).toBe('failed')
    await recognizeCapture(d, id) // ponów
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))

    const stranded = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeStranded(d)
    expect(row(d, stranded).status).toBe('transcribed')
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))
  })
})
```

- [ ] **Step 2: Failing route tests.** Create `app/api/captures/route.test.ts`. Its setup mirrors `app/api/captures/[id]/route.test.ts`: `FISZKI_DB` points at a temp file before any import, and `@/lib/transcribe` is mocked:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-captures-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const transcribeMock = vi.fn().mockResolvedValue('kot')
vi.mock('@/lib/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcribe')>()
  return { ...actual, getTranscriber: () => ({ transcribe: transcribeMock }) }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs, media } = await import('@/lib/db/schema')

function upload(lang?: string) {
  const form = new FormData()
  form.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'capture.webm')
  if (lang !== undefined) form.set('lang', lang)
  return POST(new Request('http://test/api/captures', { method: 'POST', body: form }))
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(media).run()
  transcribeMock.mockClear()
})

describe('POST /api/captures', () => {
  it.each(['pl', 'ru'])('stores a %s recording', async (lang) => {
    const res = await upload(lang)
    expect(res.status).toBe(202)
    expect(db.select().from(captures).get()!.lang).toBe(lang)
  })

  // An outbox entry saved before the language existed still uploads.
  it('stores a recording without a language as Polish', async () => {
    await upload()
    expect(db.select().from(captures).get()!.lang).toBe('pl')
  })

  it('refuses an unknown language and stores nothing', async () => {
    expect((await upload('de')).status).toBe(400)
    expect(db.select().from(captures).all()).toEqual([])
    expect(db.select().from(media).all()).toEqual([])
  })
})
```

- [ ] **Step 3: Run them and watch them fail.** `npx vitest run lib/capture/pipeline.test.ts app/api/captures/route.test.ts` should fail: `lang` is not stored, and the transcriber is called without it.

- [ ] **Step 4: Implement.**

In `lib/capture/pipeline.ts`, change `createCapture` to:

```ts
export function createCapture(
  db: Db,
  audio: { bytes: Uint8Array; mime: string },
  now: Date,
  lang: DictationLang = 'pl',
): string {
```

Add `lang,` to its `.values({...})`. In `recognizeCapture`, change the transcribe call to:

```ts
    // The language is the button the recording was made with (spec
    // 2026-09-18-recording-language §2); a recording from before that has
    // none and was always recognised as Polish.
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime, lang: capture.lang ?? 'pl' })
```

In `app/api/captures/route.ts` `POST`, after the `audio` check and **before** `createCapture`:

```ts
  // Chosen by the button held on /dodaj. Absent from an outbox entry saved
  // before the language existed, which was a Polish recording.
  const langField = form.get('lang')
  if (langField !== null && langField !== 'pl' && langField !== 'ru') {
    return NextResponse.json({ error: 'lang must be pl or ru' }, { status: 400 })
  }
  const lang: DictationLang = langField ?? 'pl'
```

Pass `lang` as `createCapture`'s fourth argument, and import `type DictationLang` from `@/lib/transcribe`.

- [ ] **Step 5: Run the tests.** `npx vitest run lib/capture app/api/captures` should pass.
- [ ] **Step 6: Gates, then commit.**

```bash
git add lib/capture/pipeline.ts lib/capture/pipeline.test.ts app/api/captures/route.ts app/api/captures/route.test.ts
git commit -m "feat: recognise a recording in the language it was made in"
```

---

### Task 3: Remove server-side re-recognition

**Files:**
- Delete: `app/api/captures/[id]/jezyk/route.ts`, `app/api/captures/[id]/jezyk/route.test.ts`
- Modify: `lib/capture/pipeline.ts`, `lib/capture/pipeline.test.ts`, `lib/queue/jobs.ts`, `lib/queue/jobs.test.ts`, `lib/db/schema.ts`, `app/api/cards/[id]/route.ts`, `app/api/cards/[id]/route.test.ts`

**Interfaces:**
- Produces: `JobKind = 'new' | 'regenerate' | 'suggest'`; `jobHandlers` has exactly those three keys. `GET /api/cards/:id` returns `{ card, generating, topic }`, with no `captureId`.

This is a removal, so there is no red step for the deletions themselves. Add one guard test (Step 1) that fails today, delete, then show the gates green.

- [ ] **Step 1: Guard tests that fail today.**

In `lib/capture/pipeline.test.ts`, inside `describe('jobHandlers')`:

```ts
  it('has a handler for exactly the three job kinds', () => {
    const h = jobHandlers({ ...deps(), suggester: { suggest: vi.fn() } })
    expect(Object.keys(h).sort()).toEqual(['new', 'regenerate', 'suggest'])
  })
```

In `app/api/cards/[id]/route.test.ts`:

```ts
  it('no longer offers a recording to re-recognise', async () => {
    seedCard({ id: 'k1' })
    expect(await (await get('k1')).json()).not.toHaveProperty('captureId')
  })
```

Run `npx vitest run lib/capture app/api/cards` and confirm both fail.

- [ ] **Step 2: Delete.**
  - `git rm -r "app/api/captures/[id]/jezyk"`.
  - `lib/capture/pipeline.ts`: delete `rerecognize`, `queueRerecognized`, `applyRerecognized`, `giveUpRerecognized`, `creatorCaptureId` and their doc comments. Delete the `rerecognized` entry in `jobHandlers`. Update its doc comment ("The three job kinds…"). Remove now-unused imports: `hasQueuedJobFor`, `applyGeneratedFields` if unused, `DictationLang` only if unused (Task 2 uses it in `createCapture`). Keep `liveCard`, which the `regenerate` handler uses.
  - `lib/queue/jobs.ts`: change `JobKind` to `'new' | 'regenerate' | 'suggest'`. Delete `hasQueuedJobFor` and its comment. Fix any comment that mentions `rerecognized`.
  - `lib/db/schema.ts`: change `generationJobs.kind`'s enum to `['new', 'regenerate', 'suggest']`.
  - `app/api/cards/[id]/route.ts` `GET`: return `{ card, generating: hasActiveJob(db, id), topic }`. Delete the `creatorCaptureId` import and the comment about offering re-recognition. Rewrite the remaining comment so it only explains `generating`.
  - `lib/queue/jobs.test.ts`: remove `rerecognized: h` from `fakeHandlers`, and delete the `hasQueuedJobFor` tests and its import.
  - `lib/capture/pipeline.test.ts`: delete the `describe` blocks and tests for `rerecognize`, `applyRerecognized`, `giveUpRerecognized` and `creatorCaptureId`, plus their imports. In `describe('jobHandlers')`, delete the parts of "wires each job kind to its body" that exercise `rerecognized`, and keep the `new` and `regenerate` parts.
  - `app/api/cards/[id]/route.test.ts`: delete assertions about `captureId`, except the new guard.
  - Then run `grep -rn "rerecogni\|jezyk\|creatorCaptureId\|hasQueuedJobFor" app lib components hooks scripts`. It must print nothing, so fix every hit, including comments.
- [ ] **Step 3: Run the tests.** `npx vitest run lib app/api` should pass, and `npx tsc --noEmit` should be clean.
- [ ] **Step 4: Gates, then commit.**

```bash
git add -A lib app/api
git commit -m "refactor: remove re-recognition — the queue job, its route and the card link"
```

---

### Task 4: Two buttons, and no language controls on screen

**Files:**
- Modify: `lib/capture/outbox.ts`, `lib/capture/outbox.test.ts`, `app/dodaj/page.tsx`, `app/dodaj/page.dom.test.tsx`, `components/CaptureChip.tsx`, `components/CaptureChip.dom.test.tsx`, `app/fiszki/[id]/page.tsx`, `app/fiszki/[id]/page.dom.test.tsx`, `i18n/pl.ts`, `i18n/pl.test.ts`

**Interfaces:**
- Consumes: `POST /api/captures` with multipart `lang` (Task 2); `GET /api/cards/:id` without `captureId` (Task 3).
- Produces: `OutboxItem.lang?: DictationLang`, which is optional so entries saved before this change still load. `enqueue` requires it for new items. The strings `recordPolish: 'nagraj po polsku'` and `recordRussian: 'nagraj po rosyjsku'` become the buttons' accessible names. The visible labels are `PL` / `RU`, and `holdToRecord` stays as the caption above the buttons.

- [ ] **Step 1: Strings.** In `i18n/pl.ts`, add `recordPolish: 'nagraj po polsku'` and `recordRussian: 'nagraj po rosyjsku'`, and remove `recognizeAs` and `languageFailed`. In `i18n/pl.test.ts`, add `'recordPolish', 'recordRussian'` to `required`.

- [ ] **Step 2: Failing tests.**

`lib/capture/outbox.test.ts`, in its existing style:

```ts
  it('keeps the language of a recording through the outbox', async () => {
    await enqueue({ id: 'a', bytes: new ArrayBuffer(1), mime: 'audio/webm', createdAt: 1, lang: 'ru' })
    expect((await listOutbox())[0].lang).toBe('ru')
  })
```

`app/dodaj/page.dom.test.tsx`:

- Every `getByRole('button', { name: t.holdToRecord })` becomes `{ name: t.recordPolish }`.
- The layout tests that `findByText(t.holdToRecord)` should find the PL button by role instead. Keep their assertions: the buttons sit after the list, fixed to the viewport, with room reserved under the list.
- Add:

```tsx
  it.each([
    ['recordPolish', 'pl'],
    ['recordRussian', 'ru'],
  ] as const)('uploads a recording held on %s with lang=%s', async (key, lang) => {
    stubMic()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const posts: FormData[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(init.body as FormData)
      return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ captures: [], captureId: 'c' }) }) as unknown as Promise<Response>
    }))
    render(<AddPage />)
    const button = screen.getByRole('button', { name: t[key] })
    fireEvent.pointerDown(button)
    await act(async () => { await new Promise((r) => setTimeout(r, 350)) })
    fireEvent.pointerUp(button)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].get('lang')).toBe(lang)
  })

  it('offers no language controls on a recording under review', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ captures: [{ ...captureRow('cap-1', 'transcribed'), transcript: 'kot' }] }) }) as unknown as Promise<Response>,
    ))
    render(<AddPage />)
    await screen.findByText('kot')
    expect(screen.queryByText(t.asPolish)).toBeNull()
    expect(screen.queryByText(t.asRussian)).toBeNull()
  })
```

Delete the re-recognition tests: "asks the server to re-recognise…", "disables the chip controls … while a re-recognition is in flight", and "shows a notice when re-recognition is refused / never reaches the server".

The fake timing in the upload test is a suggestion. `useHoldToRecord` discards a hold shorter than `minMs = 300`, so follow whatever the existing recording tests in this file already do to get past that, rather than inventing a new pattern.

`components/CaptureChip.dom.test.tsx`: delete the `onRelanguage` tests and the prop from every render. Add a test that an under-review chip shows `t.deleteItem` and neither `t.asPolish` nor `t.asRussian`.

`app/fiszki/[id]/page.dom.test.tsx`: delete the re-recognition tests, and drop `captureId` from `stubFetch`'s response and its parameter. Add a test that a card page shows neither `t.asPolish` nor `t.asRussian`.

Run `npx vitest run lib/capture/outbox.test.ts app/dodaj components/CaptureChip.dom.test.tsx "app/fiszki/[id]"` and confirm the new tests fail: there is no PL/RU button, and the language controls are still present.

- [ ] **Step 3: Implement.**
  - **`lib/capture/outbox.ts`:** add `lang?: DictationLang` to `OutboxItem` (`import type { DictationLang } from '../transcribe'`), with a comment: "absent on entries saved before the language existed; they upload as Polish". Make `enqueue`'s parameter require `lang`: `Omit<OutboxItem, 'attempts' | 'lang'> & { lang: DictationLang }`.
  - **`app/dodaj/page.tsx`:**
    - `onRecorded` takes `lang` and passes it into `enqueue`.
    - `drain` appends it to the upload with `if (item.lang) form.set('lang', item.lang)`. An older entry sends no field and the server stores `pl`.
    - Create two recorders, one per button, from the same `factory`:

      ```tsx
      const factory = useMemo(() => mediaRecorderFactory(getStream), [getStream])
      const onRecordedPl = useCallback((b: ArrayBuffer, m: string) => void onRecorded(b, m, 'pl'), [onRecorded])
      const onRecordedRu = useCallback((b: ArrayBuffer, m: string) => void onRecorded(b, m, 'ru'), [onRecorded])
      const pl = useHoldToRecord({ factory, onRecorded: onRecordedPl })
      const ru = useHoldToRecord({ factory, onRecorded: onRecordedRu })
      ```

    - The fixed bottom bar holds the `t.holdToRecord` caption and two buttons side by side, each `h-36 w-36` so both fit a phone, red while its own recorder is recording. The buttons read `PL` and `RU`, with `aria-label={t.recordPolish}` / `aria-label={t.recordRussian}`, and keep today's pointer handlers, vibration, `onContextMenu` and `touchAction` styles.
    - Delete `relanguage`, the `languageFailed` notice and its `NOTICE_TEXT` entry, the `onRelanguage` prop and the `DictationLang` import if unused. Fix the comments that mention re-recognition or "Polish by default". The `pending` set stays for `ponów`, so update its comment.
  - **`components/CaptureChip.tsx`:** remove the `onRelanguage` prop, the language-controls block and its comment. Fix the component doc comment: an under-review recording offers `usuń`, and a wrong language means `usuń` and record again. `pending` now only covers `ponów`.
  - **`app/fiszki/[id]/page.tsx`:** remove the `captureId`, `langError` and `langPending` state, `relanguage`, the controls block, the `languageFailed` line, the `DictationLang` import, and the `captureId` field read from the GET body. Fix the comments that mention re-recognition: `generating` now only comes from `wygeneruj ponownie`.
  - Then run `grep -rn "relanguage\|recognizeAs\|languageFailed\|onRelanguage" app components lib i18n`. It must print nothing.
- [ ] **Step 4: Run the tests.** `npx vitest run lib/capture app/dodaj components "app/fiszki" i18n` should pass. Run `app/dodaj/page.dom.test.tsx` 3 times and report how many runs were fully green.
- [ ] **Step 5: Gates, then commit.**

```bash
git add -A lib/capture app/dodaj components "app/fiszki" i18n
git commit -m "feat: record with PL and RU buttons; no language controls afterwards"
```

---

### Task 5: Deploy and verify (controller-only)

Done by the controller, and only with the user's go-ahead. Deploy facts are in memory (`fiszki-vm-deployment`). **Keep the database.**

- [ ] **Step 1:** Gates on the finished branch.
- [ ] **Step 2:** Back up with `systemctl start fiszki-backup.service` and confirm the upload in its journal.
- [ ] **Step 3:** Do a fresh-tree swap, detached, and poll its log. Before the build, confirm the new tree has no `app/api/captures/[id]/jezyk`.
- [ ] **Step 4:** Verify:
  - `_migrations` lists `004-capture-lang.sql`;
  - `captures.lang` exists;
  - the card count is unchanged;
  - no `rerecognized` job is `queued` or `running`;
  - the pages return 200;
  - `check-providers` passes.
- [ ] **Step 5:** Ask the user to test on the phone: hold RU for a Russian word and PL for a Polish one, and check that both become correct cards.
