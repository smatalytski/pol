# UI Round Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accept-now to recordings under review, pin the filters on `/fiszki` and `/tematy`, move "new topic" to a `+` button above the tab bar, make the settings numbers one-line rows under an `Ogólne` heading, and replace `/sluchaj`'s wall of topic chips with an explicit add/remove list behind a search sheet.

**Architecture:** One server change (splitting *which recordings are approved* from *promoting them*, so a button can promote one immediately without lying about the clock) plus one new shared overlay component (`Sheet`). Everything else is markup inside existing screens. No database migration.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4, Drizzle + better-sqlite3, Vitest (`jsdom` for component tests), Testing Library, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-20-ui-round-two-design.md`

## Global Constraints

- **All user-facing text is Polish and lives in `i18n/pl.ts`.** Never inline a Polish string in a component. `i18n/pl.test.ts` holds a `required` array naming every key; adding or removing a key means editing that array too.
- **Icons come only from `components/ui/icons.ts`**, which re-exports the exact lucide icons in use. Importing from `lucide-react` anywhere else is wrong.
- **Filled surfaces use `bg-primary`** (the `--primary` token, `#262626`), never `bg-black`.
- **No database migration in this round.** The latest is `007-prompt-commas.sql` and it stays that way.
- **Tests run with `npm test`** (`vitest run`). Component tests need `// @vitest-environment jsdom` as the first line. `npm run lint` and `npm run typecheck` must both stay clean.
- **Commit after every task**, with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Split promotion from the clock

**Files:**
- Modify: `lib/queue/jobs.ts:86-131` (`promoteApproved`)
- Test: `lib/queue/jobs.test.ts`

**Interfaces:**
- Consumes: `underReview(db)` and `approvedIds(rows, ms)`, both already exported.
- Produces: `promoteIds(db: Db, ids: readonly string[], now: Date): { queued: string[]; duplicates: string[] }`. Task 2 calls it. `promoteApproved(db, now)` keeps its exact signature and behaviour.

- [ ] **Step 1: Write the failing test**

Add to `lib/queue/jobs.test.ts`. The existing `capture()` helper at the top of that file inserts a `transcribed` row with `transcribedAt: T`, which is exactly a recording mid-review.

```ts
describe('promoteIds', () => {
  it('promotes a named recording even though its review window is still open', () => {
    const { db } = createTestDb()
    capture(db, 'c1')
    // at(0) is the instant the transcript landed — nothing is approved by the clock yet.
    expect(promoteApproved(db, at(0))).toEqual({ queued: [], duplicates: [] })

    expect(promoteIds(db, ['c1'], at(0))).toEqual({ queued: ['c1'], duplicates: [] })
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('is a no-op the second time, so a double tap cannot make two cards', () => {
    const { db } = createTestDb()
    capture(db, 'c1')
    promoteIds(db, ['c1'], at(0))
    expect(promoteIds(db, ['c1'], at(0))).toEqual({ queued: [], duplicates: [] })
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('ignores an id that is not under review', () => {
    const { db } = createTestDb()
    capture(db, 'c1', { status: 'failed' })
    expect(promoteIds(db, ['c1'], at(0))).toEqual({ queued: [], duplicates: [] })
    expect(db.select().from(generationJobs).all()).toHaveLength(0)
  })

  it('leaves the recordings it was not asked about alone', () => {
    const { db } = createTestDb()
    capture(db, 'c1')
    capture(db, 'c2')
    expect(promoteIds(db, ['c1'], at(0)).queued).toEqual(['c1'])
    expect(db.select().from(captures).where(eq(captures.id, 'c2')).get()!.status).toBe('transcribed')
  })
})
```

Add `promoteIds` to the existing import from `./jobs` at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/queue/jobs.test.ts`
Expected: FAIL — `promoteIds is not a function` (or a TypeScript error that it is not exported).

- [ ] **Step 3: Write the implementation**

In `lib/queue/jobs.ts`, replace the whole of `promoteApproved` (its doc comment and body) with the two functions below. The transaction body is moved verbatim — do not rewrite it.

```ts
/**
 * Promote exactly these recordings, whatever the clock says: a word already
 * in the deck becomes 'duplicate' and is never queued (§4); any other becomes
 * 'queued' with a `new` job. A word whose matched card was deleted during the
 * window counts as new, and its stale duplicate_of is cleared. One
 * transaction, so a recording is never queued without its job.
 * Processed oldest-transcribed-first (ties broken by createdAt) so that, when
 * several recordings are promoted at once, their jobs are inserted in a fixed,
 * sensible order rather than whatever order a Set yields.
 * Ids that are not under review are skipped, which is what makes promoting
 * the same recording twice a no-op rather than a second card.
 */
export function promoteIds(db: Db, ids: readonly string[], now: Date): { queued: string[]; duplicates: string[] } {
  const wanted = new Set(ids)
  const ordered = underReview(db)
    .filter((r) => wanted.has(r.id))
    .sort((a, b) => a.transcribedAt - b.transcribedAt || a.createdAt - b.createdAt)
  const queued: string[] = []
  const duplicates: string[] = []
  db.transaction((tx) => {
    for (const { id } of ordered) {
      const row = tx
        .select({ duplicateOf: captures.duplicateOf })
        .from(captures)
        .where(and(eq(captures.id, id), eq(captures.status, 'transcribed')))
        .get()
      if (!row) continue
      const liveMatch =
        row.duplicateOf &&
        tx
          .select({ id: cards.id })
          .from(cards)
          .where(and(eq(cards.id, row.duplicateOf), isNull(cards.deletedAt)))
          .get()
      if (liveMatch) {
        tx.update(captures).set({ status: 'duplicate' }).where(eq(captures.id, id)).run()
        duplicates.push(id)
      } else {
        tx.update(captures).set({ status: 'queued', duplicateOf: null }).where(eq(captures.id, id)).run()
        enqueueJob(tx as unknown as Db, { kind: 'new', captureId: id }, now)
        queued.push(id)
      }
    }
  })
  return { queued, duplicates }
}

/**
 * Every recording whose review window is up leaves review (§3). The worker's
 * entry point; `promoteIds` does the work.
 * `underReview` is read twice — once here to decide, once inside `promoteIds`
 * to order — which is two cheap indexed selects and keeps the ordering rule in
 * exactly one place.
 */
export function promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] } {
  return promoteIds(db, [...approvedIds(underReview(db), now.getTime())], now)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/queue/jobs.test.ts lib/queue/worker.test.ts`
Expected: PASS. The existing `promoteApproved` tests must pass untouched — that is the proof the split changed no behaviour.

- [ ] **Step 5: Commit**

```bash
git add lib/queue/jobs.ts lib/queue/jobs.test.ts
git commit -m "refactor: split promoteIds out of promoteApproved

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The approve endpoint

**Files:**
- Create: `app/api/captures/[id]/zatwierdz/route.ts`
- Create: `app/api/captures/[id]/zatwierdz/route.test.ts`

**Interfaces:**
- Consumes: `promoteIds` from Task 1.
- Produces: `POST /api/captures/:id/zatwierdz` → `200 {ok:true}` / `404` / `409`. Task 4 calls it.

- [ ] **Step 1: Write the failing test**

Create `app/api/captures/[id]/zatwierdz/route.test.ts`. The `FISZKI_DB` dance before the dynamic imports is required: `lib/db/client.ts` opens (and migrates) the database on import, so the env var must be set first. This mirrors `app/api/captures/[id]/route.test.ts`.

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-zatwierdz-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs } = await import('@/lib/db/schema')

const NOW = new Date('2026-09-20T10:00:00')

function seed(id: string, overrides: Partial<typeof captures.$inferInsert> = {}) {
  db.insert(captures)
    .values({
      id,
      audioMediaId: null,
      transcript: 'kot',
      status: 'transcribed',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: NOW.getTime(),
      transcribedAt: NOW.getTime(),
      duplicateOf: null,
      ...overrides,
    })
    .run()
  return id
}

function approve(id: string) {
  return POST(new Request(`http://test/api/captures/${id}/zatwierdz`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(captures).run()
})

describe('POST /api/captures/:id/zatwierdz', () => {
  it('promotes a recording under review and queues its job', async () => {
    seed('c1')
    const res = await approve('c1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('404s for an unknown recording', async () => {
    expect((await approve('nope')).status).toBe(404)
  })

  it('409s for a recording that is not under review, and queues nothing', async () => {
    seed('c1', { status: 'uploaded', transcribedAt: null })
    expect((await approve('c1')).status).toBe(409)
    expect(db.select().from(generationJobs).all()).toHaveLength(0)
  })

  it('409s on the second call, so a double tap makes one card', async () => {
    seed('c1')
    expect((await approve('c1')).status).toBe(200)
    expect((await approve('c1')).status).toBe(409)
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/api/captures/[id]/zatwierdz/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/captures/[id]/zatwierdz/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { captures } from '@/lib/db/schema'
import { promoteIds } from '@/lib/queue/jobs'

/**
 * Approves one recording now instead of waiting out its review window
 * (spec 2026-09-20 §3.2). The status check is what turns a double tap into a
 * 409 rather than a second card; `promoteIds` guards the same way inside its
 * transaction, so the two together are safe even if the checks interleave.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const row = db.select({ status: captures.status }).from(captures).where(eq(captures.id, id)).get()
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'transcribed') return NextResponse.json({ error: 'not under review' }, { status: 409 })
  promoteIds(db, [id], new Date())
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/api/captures/[id]/zatwierdz/route.test.ts"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/api/captures/[id]/zatwierdz"
git commit -m "feat: endpoint to approve a recording immediately

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Shared strings and the one new icon

Four later tasks need these; they are one small change and are done once, up front, rather than four times.

**Files:**
- Modify: `i18n/pl.ts`
- Modify: `i18n/pl.test.ts`
- Modify: `components/ui/icons.ts`

**Interfaces:**
- Produces: the keys `approveNow`, `approveFailed`, `settingsGeneral`, `filterTopics`, `addTopic`, `removeTopic`, `listenTopicsAll`, `sheetClose`, `noTopicsFound`, `allTopicsChosen` on `t`, and `Check` from `components/ui/icons.ts`. `listenAllTopics` is gone.

- [ ] **Step 1: Write the failing test**

In `i18n/pl.test.ts`, inside the `required` array: delete the `'listenAllTopics'` entry, and add a line

```ts
      'approveNow', 'approveFailed', 'settingsGeneral', 'filterTopics', 'addTopic', 'removeTopic',
      'listenTopicsAll', 'sheetClose', 'noTopicsFound', 'allTopicsChosen',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run i18n/pl.test.ts`
Expected: FAIL — the new keys are missing from `t`.

- [ ] **Step 3: Write the implementation**

In `i18n/pl.ts`, remove the `listenAllTopics: 'wszystkie',` line and add:

```ts
  approveNow: 'zatwierdź',
  approveFailed: 'Nie udało się zatwierdzić nagrania.',
  settingsGeneral: 'Ogólne',
  filterTopics: 'Szukaj tematu',
  addTopic: '+ temat',
  removeTopic: 'usuń temat',
  listenTopicsAll: 'Bez wyboru grane są wszystkie tematy.',
  sheetClose: 'zamknij',
  noTopicsFound: 'Brak tematów',
  allTopicsChosen: 'Wszystkie tematy już wybrane',
```

In `components/ui/icons.ts`, add `Check,` to the alphabetical export list (between `Archive` and `CirclePause`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run i18n/pl.test.ts components/ui/icons.test.tsx`
Expected: PASS.

Then run: `npx vitest run app/sluchaj`
Expected: FAIL — `/sluchaj` still renders `t.listenAllTopics`, which is now `undefined`. That is expected and Task 9 fixes it; do not patch it here.

- [ ] **Step 5: Commit**

```bash
git add i18n/pl.ts i18n/pl.test.ts components/ui/icons.ts
git commit -m "feat: strings and Check icon for the second UI round

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The accept button on the chip

**Files:**
- Modify: `components/CaptureChip.tsx`
- Modify: `app/dodaj/page.tsx`
- Test: `components/CaptureChip.dom.test.tsx`, `app/dodaj/page.dom.test.tsx`

**Interfaces:**
- Consumes: the endpoint from Task 2; `t.approveNow`, `t.approveFailed` and `Check` from Task 3.
- Produces: `CaptureChip` requires a new `onApprove: (id: string) => void` prop.

- [ ] **Step 1: Write the failing test**

Add to `components/CaptureChip.dom.test.tsx`. Every existing `render(<CaptureChip .../>)` call in that file also needs `onApprove={vi.fn()}` added, or TypeScript fails.

```ts
  it('offers zatwierdź only while the recording is under review', () => {
    const onApprove = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onApprove={onApprove} />)
    fireEvent.click(screen.getByText(t.approveNow))
    expect(onApprove).toHaveBeenCalledWith('cap-1')
  })

  it('hides zatwierdź once the recording has left review', () => {
    render(
      <CaptureChip
        item={captureItem({ inReview: false, reviewRemainingMs: null })}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onApprove={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.approveNow)).toBeNull()
  })

  it('disables zatwierdź while an action on this chip is in flight', () => {
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onApprove={vi.fn()} pending />)
    expect((screen.getByText(t.approveNow) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not read a tap on zatwierdź as a delete swipe', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} onApprove={vi.fn()} />)
    swipe(screen.getByText(t.approveNow), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/CaptureChip.dom.test.tsx`
Expected: FAIL — no element with the text `zatwierdź`.

- [ ] **Step 3: Write the implementation**

In `components/CaptureChip.tsx`: add `Check` to the icon import, add the prop, and add the button as the first child of the existing control row.

```tsx
import { Check, RefreshCw, Trash2 } from '@/components/ui/icons'
```

```tsx
  onApprove,
```
in the destructured props, with

```tsx
  /** Approve this recording now rather than waiting out its review window. */
  onApprove: (id: string) => void
```
in the `Props` type.

Inside the `<div className="flex justify-end gap-2">` row, before the `failed` branch:

```tsx
        {capture.inReview && (
          <Button variant="primary" icon={Check} label={t.approveNow} onClick={() => onApprove(capture.id)} disabled={pending} {...own} />
        )}
```

In `app/dodaj/page.tsx`: widen the notice type and add the handler.

```ts
type Notice = 'deleteFailed' | 'approveFailed'

const NOTICE_TEXT: Record<Notice, string> = {
  deleteFailed: t.deleteFailed,
  approveFailed: t.approveFailed,
}
```

After the `retry` callback:

```ts
  // Approving takes the recording out of review immediately (spec
  // 2026-09-20 §3). `whilePending` keeps the chip's controls disabled until
  // the refreshed list comes back, so a second tap cannot race the first; a
  // 409 from a request that did land is reported like any other failure,
  // which is honest — from here it is indistinguishable from a real refusal,
  // and the refreshed list settles it either way.
  const approve = useCallback(
    (id: string) => {
      void whilePending(id, async () => {
        try {
          const res = await fetch(`/api/captures/${id}/zatwierdz`, { method: 'POST' })
          if (mountedRef.current) setNotice(res.ok ? null : 'approveFailed')
        } catch {
          if (mountedRef.current) setNotice('approveFailed')
        }
      })
    },
    [whilePending],
  )
```

And pass it to the chip in the `.map`:

```tsx
            onApprove={approve}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run components/CaptureChip.dom.test.tsx app/dodaj`
Expected: PASS.

- [ ] **Step 5: Add the screen-level failure test**

Add to `app/dodaj/page.dom.test.tsx`, following the file's existing fetch-stubbing helper for a capture under review:

This reuses the file's own `captureRow` helper (defined at its top) and the
one-`vi.stubGlobal('fetch', ...)`-per-test shape the rest of the file uses.

```ts
  it('reports a refused approve and leaves the chip on screen', async () => {
    const list: CaptureView[] = [{ ...captureRow('cap-1', 'transcribed'), transcript: 'kot' }]
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/zatwierdz')
            ? { ok: false, status: 409, json: () => Promise.resolve({ error: 'not under review' }) }
            : { ok: true, json: () => Promise.resolve({ captures: list }) },
        ) as unknown as Promise<Response>,
      ),
    )
    render(<AddPage />)
    await waitFor(() => expect(screen.getByText(t.approveNow)).toBeTruthy())
    fireEvent.click(screen.getByText(t.approveNow))
    await waitFor(() => expect(screen.getByText(t.approveFailed)).toBeTruthy())
    // The list still returns it, so the chip stays until a real promotion.
    expect(screen.getByText('kot')).toBeTruthy()
  })
```

Put it in the same `describe` as the file's other chip-control tests, which
already `cleanup()` and `vi.unstubAllGlobals()` in their `afterEach`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run app/dodaj`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/CaptureChip.tsx components/CaptureChip.dom.test.tsx app/dodaj
git commit -m "feat: approve a recording without waiting out its review window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Pin the filter on /fiszki

**Files:**
- Modify: `app/fiszki/page.tsx:63-72`
- Test: `app/fiszki/page.dom.test.tsx`

**Interfaces:**
- Produces: nothing other tasks consume. Task 6 copies the same wrapper classes.

- [ ] **Step 1: Write the failing test**

`sticky` positioning cannot be observed in jsdom, so assert the contract that produces it — the same way `Button.dom.test.tsx` asserts `bg-primary`.

```ts
  it('pins the filter box to the top of the screen', () => {
    render(<CardsPage />)
    const box = screen.getByPlaceholderText(t.cards).closest('div')!.parentElement!
    expect(box.className).toContain('sticky')
    expect(box.className).toContain('top-0')
    // Opaque, or rows scroll through it.
    expect(box.className).toContain('bg-background')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/fiszki`
Expected: FAIL — the wrapper has no `sticky` class.

- [ ] **Step 3: Write the implementation**

In `app/fiszki/page.tsx`, wrap the existing `<div className="relative">…</div>` search box:

```tsx
      {/* Pinned, so the filter is reachable however far down the list you
          are. `-mx-4 px-4` cancels the shell's own padding (app/layout.tsx's
          `main` has `px-4 pt-4`) so the opaque background runs edge to edge
          and rows pass behind it rather than beside it. Nothing in the shell
          sets `overflow`, so this sticks to the viewport. */}
      <div className="sticky top-0 z-10 -mx-4 bg-background px-4 py-2">
        <div className="relative">
          {/* unchanged: the Search icon and the input */}
        </div>
      </div>
```

Keep the icon and `<input>` exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/fiszki`
Expected: PASS, including every pre-existing test in that file unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/fiszki
git commit -m "feat: pin the card filter to the top of the screen

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: A plus button and a filter on /tematy

**Files:**
- Modify: `app/tematy/page.tsx`
- Test: `app/tematy/page.dom.test.tsx`

**Interfaces:**
- Consumes: `t.filterTopics` from Task 3.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

```ts
  it('filters the list by topic name, ignoring case', async () => {
    stubFetch([row({ id: 't1', name: 'U lekarza' }), row({ id: 't2', name: 'Praca' })])
    render(<TopicsPage />)
    await waitFor(() => expect(screen.getByText('Praca')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(t.filterTopics), { target: { value: 'lek' } })
    expect(screen.getByText('U lekarza')).toBeTruthy()
    expect(screen.queryByText('Praca')).toBeNull()
  })

  it('pins the filter box', async () => {
    stubFetch([row()])
    render(<TopicsPage />)
    const box = screen.getByPlaceholderText(t.filterTopics).closest('div')!.parentElement!
    expect(box.className).toContain('sticky')
    expect(box.className).toContain('bg-background')
  })

  it('offers new-topic as an icon-only link that keeps its accessible name', async () => {
    stubFetch([row()])
    render(<TopicsPage />)
    const link = await screen.findByLabelText(t.newTopic)
    expect(link.getAttribute('href')).toBe('/tematy/nowy')
    // The word itself is gone — it is a plus button now.
    expect(screen.queryByText(t.newTopic)).toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/tematy/page.dom.test.tsx`
Expected: FAIL — no element with placeholder `Szukaj tematu`.

- [ ] **Step 3: Write the implementation**

In `app/tematy/page.tsx`, add the filter state next to the existing state:

```ts
  const [q, setQ] = useState('')
```

and derive the visible rows just before `return`:

```ts
  // Client-side: the list is already fully loaded, so filtering it needs no
  // request. An unnamed topic has no name to match, so it only shows on an
  // empty query.
  const query = q.trim().toLowerCase()
  const visible = topics.filter((x) => (x.name ?? '').toLowerCase().includes(query))
```

Use `visible` instead of `topics` in the `.map`.

Replace the `<Link href="/tematy/nowy" …>` element at the top with the pinned filter box, using the same wrapper as Task 5:

```tsx
      <div className="sticky top-0 z-10 -mx-4 bg-background px-4 py-2">
        <div className="relative">
          <Icon icon={Search} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 py-3 pl-10 pr-3"
            placeholder={t.filterTopics}
          />
        </div>
      </div>
```

Swap the `Plus` import line for `import { Plus, Search } from '@/components/ui/icons'`, and drop the now-unused `buttonClass` import.

Add the button as the last child of the outer `<div>`, after the `<ul>`:

```tsx
      {/* One-handed use: the thumb reaches the bottom of a phone, and this
          list grows downward, so a button above it drifts out of reach as
          topics accumulate. Fixed rather than sticky, for the reason
          app/dodaj/page.tsx's record bar documents at length; `inset-x-0`
          plus the inner `mx-auto max-w-xl` re-centres it, because a fixed
          element ignores the shell's own `max-w-xl`.
          The classes are written out rather than taken from `buttonClass`:
          this is 56 px, and a `h-14` appended after `buttonClass`'s `h-10`
          would leave two height utilities fighting in the stylesheet, where
          the winner is decided by Tailwind's output order, not by the order
          they appear in the attribute. */}
      <div className="above-tabbar fixed inset-x-0 z-10">
        <div className="mx-auto flex max-w-xl justify-end px-4 pb-4">
          <Link
            href="/tematy/nowy"
            aria-label={t.newTopic}
            title={t.newTopic}
            className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg"
          >
            <Icon icon={Plus} size={24} />
          </Link>
        </div>
      </div>
```

Give the `<ul>` a `pb-20` so the button never covers the last row.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/tematy/page.dom.test.tsx`
Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 5: Commit**

```bash
git add app/tematy/page.tsx app/tematy/page.dom.test.tsx
git commit -m "feat: plus button above the tab bar and a pinned topic filter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: One-line settings rows under an Ogólne heading

**Files:**
- Modify: `app/ustawienia/page.tsx:105-160`
- Test: `app/ustawienia/page.dom.test.tsx`

**Interfaces:**
- Consumes: `t.settingsGeneral` from Task 3.
- Produces: nothing other tasks consume.

**Do not touch** `save`, the drafts, or the effect above them. Those comments record two real review findings; this task is markup only.

- [ ] **Step 1: Write the failing test**

```ts
  it('heads the general settings with their own section title', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByText(t.settingsGeneral)).toBeTruthy())
    expect(screen.getByText(t.listenSection)).toBeTruthy()
  })

  it('lays every number out as a one-line row', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(t.newPerDay)).toBeTruthy())
    for (const label of [t.newPerDay, t.targetRetention, t.listenGap, t.listenNext]) {
      const input = screen.getByLabelText(label)
      expect(input.className).toContain('w-20')
      expect(input.closest('label')!.className).toContain('justify-between')
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/ustawienia`
Expected: FAIL — no `Ogólne` text.

- [ ] **Step 3: Write the implementation**

At the bottom of `app/ustawienia/page.tsx`, above `export default`, add the row component — four near-identical labels is the only thing worth factoring here:

```tsx
/**
 * One settings row: the name on the left, a compact number on the right, so
 * a number reads like the switches below it rather than like a form field.
 * The `<label>` wraps the input, so `getByLabelText` still finds it.
 */
function NumberRow({
  label, value, onChange, onCommit, ...input
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: () => void
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, 'min' | 'max' | 'step'>) {
  return (
    <label className="flex items-center justify-between gap-3 text-sub">
      <span>{label}</span>
      <input
        type="number"
        {...input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        className="w-20 rounded-lg border border-neutral-300 px-3 py-2 text-right text-base"
      />
    </label>
  )
}
```

Replace the four `<label className="flex flex-col gap-1 text-sub">…</label>` blocks with:

```tsx
        <h2 className="mt-2 text-xl font-bold">{t.settingsGeneral}</h2>
        <NumberRow
          label={t.newPerDay}
          min={0}
          max={200}
          value={newPerDayDraft}
          onChange={setNewPerDayDraft}
          onCommit={() => void save({ newPerDay: Number(newPerDayDraft) })}
        />
        <NumberRow
          label={t.targetRetention}
          step={0.01}
          min={0.7}
          max={0.98}
          value={retentionDraft}
          onChange={setRetentionDraft}
          onCommit={() => void save({ requestRetention: Number(retentionDraft) })}
        />
```

for the general pair (the heading first), and inside the existing listening `<div>`, before the switches:

```tsx
        <NumberRow
          label={t.listenGap}
          min={1}
          max={30}
          value={gapDraft}
          onChange={setGapDraft}
          onCommit={() => void save({ audioGapSeconds: Number(gapDraft) })}
        />
        <NumberRow
          label={t.listenNext}
          min={1}
          max={30}
          value={nextDraft}
          onChange={setNextDraft}
          onCommit={() => void save({ audioNextSeconds: Number(nextDraft) })}
        />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/ustawienia`
Expected: PASS. Every pre-existing test — including the save-and-revert ones — must pass untouched; that is the proof this was markup only.

- [ ] **Step 5: Commit**

```bash
git add app/ustawienia
git commit -m "feat: one-line settings rows under an Ogólne heading

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The Sheet component

**Files:**
- Create: `components/ui/Sheet.tsx`
- Create: `components/ui/Sheet.dom.test.tsx`

**Interfaces:**
- Consumes: `t.sheetClose` and `X` from Task 3.
- Produces: `<Sheet open={boolean} label={string} onClose={() => void}>{children}</Sheet>`. Task 9 uses it.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from './Sheet'
import { t } from '@/i18n/pl'

afterEach(cleanup)

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(<Sheet open={false} label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    expect(screen.queryByText('hello')).toBeNull()
  })

  it('is a labelled modal dialog when open', () => {
    render(<Sheet open label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('tematy')
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    render(<Sheet open label="tematy" onClose={onClose}><p>hello</p></Sheet>)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText(t.sheetClose))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('takes focus on open and locks the page behind it', () => {
    const { rerender } = render(<Sheet open={false} label="tematy" onClose={vi.fn()}><button>inside</button></Sheet>)
    expect(document.body.style.overflow).not.toBe('hidden')
    rerender(<Sheet open label="tematy" onClose={vi.fn()}><button>inside</button></Sheet>)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('gives the page back its scroll when it closes', () => {
    const { rerender } = render(<Sheet open label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    rerender(<Sheet open={false} label="tematy" onClose={vi.fn()}><p>hello</p></Sheet>)
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('keeps Tab inside the sheet', () => {
    render(
      <Sheet open label="tematy" onClose={vi.fn()}>
        <button>first</button>
      </Sheet>,
    )
    const close = screen.getByText(t.sheetClose)
    close.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('first'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/ui/Sheet.dom.test.tsx`
Expected: FAIL — cannot resolve `./Sheet`.

- [ ] **Step 3: Write the implementation**

```tsx
'use client'
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { X } from './icons'
import { t } from '@/i18n/pl'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A full-screen overlay (spec 2026-09-20 §7.2), the app's only one. It covers
 * the page rather than dimming it, so there is no backdrop to tap: it closes
 * on Escape and on `zamknij`.
 *
 * Focus moves to the dialog on open and back to whatever opened it on close,
 * and Tab is trapped in between — without that, tabbing walks into the page
 * underneath, which is still rendered and still clickable to a screen reader.
 * Body scroll is locked for the same reason: a phone otherwise scrolls the
 * page behind the sheet.
 */
export function Sheet({
  open,
  label,
  onClose,
  children,
}: {
  open: boolean
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      document.body.style.overflow = previous
      openerRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || active === ref.current)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-30 overflow-y-auto bg-background"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
        {children}
        <Button variant="secondary" size="md" icon={X} label={t.sheetClose} onClick={onClose} className="self-start" />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/ui/Sheet.dom.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add components/ui/Sheet.tsx components/ui/Sheet.dom.test.tsx
git commit -m "feat: full-screen Sheet overlay

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: An explicit topic list on /sluchaj

**Files:**
- Modify: `app/sluchaj/page.tsx:96-145`
- Test: `app/sluchaj/page.dom.test.tsx`

**Interfaces:**
- Consumes: `Sheet` from Task 8; `t.addTopic`, `t.removeTopic`, `t.listenTopicsAll`, `t.filterTopics`, `t.noTopicsFound`, `t.allTopicsChosen` from Task 3.

- [ ] **Step 1: Write the failing test**

The existing `stubFetch(topics, settings)` helper in that file is what feeds the topic list.

```ts
  it('lists no topics by default and says everything will play', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.listenTopicsAll)).toBeTruthy())
    expect(screen.queryByText('Praca')).toBeNull()
  })

  it('adds a topic through the sheet and plays only that topic', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    // The sheet closed, and the topic is now a chip.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Praca')).toBeTruthy()
    fireEvent.click(screen.getByText(t.listenStart))
    expect(start).toHaveBeenCalledWith({ minutes: 20, topicIds: ['t1'] })
  })

  it('filters the sheet by name', async () => {
    stubFetch(
      [{ id: 't1', name: 'Praca', suspendedAt: null }, { id: 't2', name: 'Dom', suspendedAt: null }],
      SETTINGS,
    )
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.change(await screen.findByPlaceholderText(t.filterTopics), { target: { value: 'dom' } })
    expect(screen.getByText('Dom')).toBeTruthy()
    expect(screen.queryByText('Praca')).toBeNull()
  })

  it('removes a chip and goes back to playing everything', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    fireEvent.click(screen.getByLabelText(`${t.removeTopic}: Praca`))
    expect(screen.getByText(t.listenTopicsAll)).toBeTruthy()
    fireEvent.click(screen.getByText(t.listenStart))
    expect(start).toHaveBeenCalledWith({ minutes: 20 })
  })

  it('says so when every topic is already chosen', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    fireEvent.click(screen.getByText(t.addTopic))
    expect(await screen.findByText(t.allTopicsChosen)).toBeTruthy()
  })
```

Declare `SETTINGS` from whatever settings object the existing tests already pass to `stubFetch`; reuse it rather than inventing a second one. Delete any existing test that asserts on the `wszystkie` chip.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/sluchaj`
Expected: FAIL — no `+ temat` button.

- [ ] **Step 3: Write the implementation**

In `app/sluchaj/page.tsx`, add the imports:

```ts
import { Sheet } from '@/components/ui/Sheet'
import { Pause, Play, RotateCcw, SkipForward, Square, X } from '@/components/ui/icons'
```

Add state next to the others:

```ts
  const [pickerOpen, setPickerOpen] = useState(false)
  const [topicQuery, setTopicQuery] = useState('')
```

Replace `chooseAllTopics` and `toggleTopic` with:

```ts
  function addTopic(id: string) {
    setSelectedTopicIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setPickerOpen(false)
    setTopicQuery('')
  }

  function removeTopic(id: string) {
    setSelectedTopicIds((prev) => prev.filter((x) => x !== id))
  }
```

Replace the whole `<div className="flex flex-wrap gap-2">…</div>` chip block in the idle branch with:

```tsx
        {/* No selection means every topic — `handleStart` below sends no
            `topicIds` at all in that case, which is what the planner already
            treats as "everything". A `wszystkie` chip alongside this would be
            a second way to say the same thing, free to disagree with it. */}
        <div className="flex flex-col gap-2">
          {selectedTopicIds.length === 0 ? (
            <p className="text-sub text-neutral-500">{t.listenTopicsAll}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {selectedTopicIds.map((id) => {
                const name = topics.find((x) => x.id === id)?.name ?? t.unnamedTopic
                return (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary py-1.5 pl-3 pr-1.5 text-sm text-white">
                    {name}
                    <button type="button" aria-label={`${t.removeTopic}: ${name}`} onClick={() => removeTopic(id)}>
                      <Icon icon={X} size={16} />
                    </button>
                  </span>
                )
              })}
            </div>
          )}
          <Button variant="secondary" label={t.addTopic} onClick={() => setPickerOpen(true)} className="self-start" />
        </div>
```

Add `import { Icon } from '@/components/ui/Icon'` if it is not already imported.

Add the sheet as the last child of the idle branch's outer `<div>`:

```tsx
        <Sheet open={pickerOpen} label={t.addTopic} onClose={() => { setPickerOpen(false); setTopicQuery('') }}>
          <input
            autoFocus
            value={topicQuery}
            onChange={(e) => setTopicQuery(e.target.value)}
            placeholder={t.filterTopics}
            className="w-full rounded-lg border border-neutral-300 px-3 py-3"
          />
          {pickable.length === 0 ? (
            <p className="text-sub text-neutral-500">
              {topics.length > 0 && selectedTopicIds.length === topics.length ? t.allTopicsChosen : t.noTopicsFound}
            </p>
          ) : (
            <ul>
              {pickable.map((topic) => (
                <li key={topic.id}>
                  <button type="button" onClick={() => addTopic(topic.id)} className="w-full border-b py-3 text-left text-row">
                    {topic.name ?? t.unnamedTopic}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
```

Derive `pickable` just above the idle branch's `content = (`:

```ts
  // The sheet offers what is not already chosen; `topics` is already filtered
  // to unsuspended ones where it is fetched.
  const topicSearch = topicQuery.trim().toLowerCase()
  const pickable = topics.filter(
    (x) => !selectedTopicIds.includes(x.id) && (x.name ?? '').toLowerCase().includes(topicSearch),
  )
```

`handleStart` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/sluchaj`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/sluchaj
git commit -m "feat: choose listening topics through a search sheet

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Whole-suite verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS, with a higher test count than the 863 this round started from.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both clean. A likely failure here is an unused import left behind in `app/tematy/page.tsx` (`buttonClass`) or `app/sluchaj/page.tsx`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles. This is the only check that catches a Tailwind class that does not exist or a server/client boundary mistake.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: whole-suite findings for the second UI round

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
