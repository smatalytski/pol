# Remembered Screens and Topic Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each screen's place across tab switches, let `/dodaj` file recordings into a chosen topic, and make the topic page's hand-add a collapsed, text-only bar on `z kartą` that creates cards directly.

**Architecture:** A client provider mounted in the root layout holds one `Map` of screen key → remembered state; screens read it through `useState`/`useReducer`-shaped hooks that mirror their local state into it. The routes, the URLs and every existing polling loop are untouched. The topic on `/dodaj` rides an existing but unused `captures.topic_id` column through the existing pipeline, so no migration and no generation code change.

**Tech Stack:** Next.js 15 App Router (client components), React 19, TypeScript, Tailwind v4, Drizzle + better-sqlite3, Vitest + Testing Library (jsdom for `.dom.test.tsx`), `idb-keyval` for the offline outbox.

**Spec:** `docs/superpowers/specs/2026-09-22-screen-state-and-topic-capture-design.md`

## Global Constraints

- **Polish UI copy only**, and every user-visible string comes from `i18n/pl.ts` — never a literal in a component.
- **Icons come only from `components/ui/icons.ts`**, the single door to `lucide-react` (spec 2026-09-19-ui-icons §3.1). Add an icon there first if you need one.
- **Tap targets are at least 32×32** (WCAG 2.5.8); the app's round action buttons are 56×56 (`h-14 w-14`).
- **Fixed bottom elements** use the `above-tabbar` utility and an opaque `bg-background`; a full-width fixed band must be `pointer-events-none` with `pointer-events-auto` on the button itself, or it swallows taps meant for rows underneath (regression fixed in 553b8e8).
- **State is in memory only.** Nothing in this plan may write screen state to `localStorage` or `sessionStorage`. The one pre-existing exception, the topic page's remembered tab, stays as it is.
- **Tests:** unit and route tests are `*.test.ts` under `lib/` or beside the route; component tests are `*.dom.test.tsx` and start with the `// @vitest-environment jsdom` pragma. Run a single file with `npx vitest run <path>`.
- **Commit after every task**, with the repo's `type: lowercase summary` message style.

---

### Task 1: Swap `fiszki` and `tematy` in the tab bar

**Files:**
- Modify: `components/TabBar.tsx:9-16`
- Test: `components/TabBar.dom.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other code reads; `TABS` stays module-private.

- [ ] **Step 1: Write the failing test**

Add to `components/TabBar.dom.test.tsx`:

```tsx
it('puts tematy beside dodaj, in the thumb zone', () => {
  render(<TabBar />)
  const labels = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
  expect(labels).toEqual(['/powtorki', '/sluchaj', '/dodaj', '/tematy', '/fiszki', '/ustawienia'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run components/TabBar.dom.test.tsx`
Expected: FAIL — the array comes back with `/fiszki` before `/tematy`.

- [ ] **Step 3: Swap the two entries**

In `components/TabBar.tsx`, the `TABS` array becomes:

```tsx
const TABS: ReadonlyArray<{ href: string; label: string; short?: string; icon: LucideIcon }> = [
  { href: '/powtorki', label: t.review, icon: RotateCcw },
  { href: '/sluchaj', label: t.listen, icon: Headphones },
  { href: '/dodaj', label: t.add, icon: Mic },
  { href: '/tematy', label: t.topics, icon: List },
  { href: '/fiszki', label: t.cards, icon: Layers },
  { href: '/ustawienia', label: t.settings, short: t.settingsTab, icon: Settings },
]
```

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run components/TabBar.dom.test.tsx`
Expected: PASS. If an older test asserts the previous order, update that test — the order is the change.

- [ ] **Step 5: Commit**

```bash
git add components/TabBar.tsx components/TabBar.dom.test.tsx
git commit -m "feat: move tematy next to dodaj in the tab bar"
```

---

### Task 2: The session store

**Files:**
- Create: `components/SessionState.tsx`
- Create: `components/SessionState.dom.test.tsx`
- Modify: `app/layout.tsx:17-19`

**Interfaces:**
- Consumes: nothing.
- Produces — every later task depends on these exact names:
  - `<SessionState>{children}</SessionState>` — the provider.
  - `useScreenState<T>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>]`
  - `useScreenReducer<S, A>(key: string, reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>]`
  - `useRestoreScroll(key: string, ready: boolean): void`

- [ ] **Step 1: Write the failing tests**

Create `components/SessionState.dom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionState, useScreenState } from './SessionState'

afterEach(cleanup)

function Counter({ storeKey }: { storeKey: string }) {
  const [n, setN] = useScreenState(storeKey, () => 0)
  return <button onClick={() => setN(n + 1)}>{`${storeKey}=${n}`}</button>
}

describe('useScreenState', () => {
  it('keeps a screen’s value across unmount and remount', () => {
    const view = render(
      <SessionState>
        <Counter storeKey="a" />
      </SessionState>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('a=1')

    // Same provider, child unmounted and mounted again — a tab switch.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Counter storeKey="a" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('a=1')
  })

  it('does not let two keys share a slice, even without a remount', () => {
    const view = render(
      <SessionState>
        <Counter storeKey="t1" />
      </SessionState>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('t1=1')

    // The key changes while the component stays mounted: /tematy/t1 -> /tematy/t2.
    view.rerender(<SessionState><Counter storeKey="t2" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('t2=0')

    view.rerender(<SessionState><Counter storeKey="t1" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('t1=1')
  })

  it('starts fresh under a new provider, so nothing outlives a reload', () => {
    const first = render(<SessionState><Counter storeKey="a" /></SessionState>)
    fireEvent.click(screen.getByRole('button'))
    first.unmount()
    render(<SessionState><Counter storeKey="a" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('a=0')
  })
})

function Scrolled({ ready }: { ready: boolean }) {
  useRestoreScroll('s', ready)
  return <span>scrolled</span>
}

describe('useRestoreScroll', () => {
  it('waits for content before restoring, so the restore is not clamped to 0', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const view = render(<SessionState><Scrolled ready={true} /></SessionState>)

    // Scrolling is what records the position; jsdom does not move the window,
    // so set scrollY by hand and fire the event the hook listens for.
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true })
    fireEvent.scroll(window)

    // Back with nothing rendered yet: no restore, because the page is short.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Scrolled ready={false} /></SessionState>)
    expect(scrollTo).not.toHaveBeenCalled()

    // Content has arrived: now it restores, exactly once.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Scrolled ready={true} /></SessionState>)
    expect(scrollTo).toHaveBeenCalledWith(0, 240)
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})
```

The imports at the top of the file are `import { SessionState, useRestoreScroll, useScreenState } from './SessionState'` and `vi` from vitest; `afterEach` also calls `vi.unstubAllGlobals()`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run components/SessionState.dom.test.tsx`
Expected: FAIL — cannot resolve `./SessionState`.

- [ ] **Step 3: Write the store**

Create `components/SessionState.tsx`:

```tsx
'use client'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type Reducer,
  type SetStateAction,
} from 'react'

/**
 * Where each screen's place is kept while you are on another one (spec
 * 2026-09-22 §3). Mounted in the root layout, which a client navigation does
 * not unmount, so this outlives every tab switch and nothing else.
 *
 * The store is a plain Map in a ref, never state: a screen writing its value
 * back must not re-render the whole app underneath the layout. Screens keep
 * their own useState/useReducer for rendering and mirror into the Map, so a
 * keystroke re-renders exactly the screen it happened on, as it does today.
 *
 * Deliberately in memory only. It is emptied by a reload, which is the whole
 * lifetime the spec asks for (§2) — anything longer would mean re-validating
 * every restored value against the server on the way back in.
 */
const StoreContext = createContext<Map<string, unknown> | null>(null)

export function SessionState({ children }: { children: ReactNode }) {
  const ref = useRef<Map<string, unknown> | null>(null)
  ref.current ??= new Map()
  return <StoreContext.Provider value={ref.current}>{children}</StoreContext.Provider>
}

function useStore(): Map<string, unknown> {
  const store = useContext(StoreContext)
  // A screen outside the provider would silently forget everything, which is
  // exactly the bug this exists to prevent — so it is a crash, not a fallback.
  if (!store) throw new Error('session hooks used outside <SessionState>')
  return store
}

/** Drop-in for useState, backed by the store. `initial` runs only when the key has nothing yet. */
export function useScreenState<T>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const store = useStore()
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : initial()))
  // The key can change without a remount — /tematy/t1 to /tematy/t2 keeps this
  // component mounted — so re-seed during render (React's documented "adjust
  // state when a prop changes" pattern) rather than in an effect, which would
  // paint one frame of the previous topic's draft first.
  const seeded = useRef(key)
  if (seeded.current !== key) {
    seeded.current = key
    setValue(store.has(key) ? (store.get(key) as T) : initial())
  }
  useEffect(() => {
    store.set(key, value)
  }, [store, key, value])
  return [value, setValue]
}

/** Drop-in for useReducer, backed by the store — /powtorki's reviewReducer. */
export function useScreenReducer<S, A>(key: string, reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>] {
  const store = useStore()
  const [state, dispatch] = useReducer(reducer, undefined as never, () =>
    store.has(key) ? (store.get(key) as S) : initial,
  )
  useEffect(() => {
    store.set(key, state)
  }, [store, key, state])
  return [state, dispatch]
}

/**
 * Restores a screen's scroll position once it has something to scroll.
 *
 * `ready` is not optional dressing: a screen that fetches its list paints
 * short on mount, and a scroll restored then is clamped to 0 by the browser.
 * The position is recorded from a passive scroll listener straight into the
 * Map rather than read at unmount, so it survives a navigation that scrolls
 * the window before this screen tears down.
 */
export function useRestoreScroll(key: string, ready: boolean): void {
  const store = useStore()
  const storeKey = `scroll:${key}`
  const restored = useRef(false)

  useEffect(() => {
    const onScroll = () => store.set(storeKey, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [store, storeKey])

  useLayoutEffect(() => {
    if (restored.current || !ready) return
    restored.current = true
    const y = store.get(storeKey)
    if (typeof y === 'number' && y > 0) window.scrollTo(0, y)
  }, [store, storeKey, ready])
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run components/SessionState.dom.test.tsx`
Expected: PASS, all four.

- [ ] **Step 5: Mount the provider in the root layout**

In `app/layout.tsx`, import it and wrap the routed content — inside `<main>`, so the provider owns only the pages:

```tsx
import { SessionState } from '@/components/SessionState'
...
<main className="pad-below-tabbar px-4 pt-4">
  <SessionState>{children}</SessionState>
</main>
```

- [ ] **Step 6: Check nothing else broke**

Run: `npm test && npm run typecheck`
Expected: PASS. No screen uses the hooks yet, so this step only proves the provider is inert.

- [ ] **Step 7: Commit**

```bash
git add components/SessionState.tsx components/SessionState.dom.test.tsx app/layout.tsx
git commit -m "feat: keep screen state in a store above the routes"
```

---

### Task 3: `/powtorki` resumes exactly

**Files:**
- Modify: `app/powtorki/page.tsx:12-20` (state) and `:39-48` (the load effect)
- Test: `app/powtorki/page.dom.test.tsx`

**Interfaces:**
- Consumes: `useScreenState`, `useScreenReducer`, `SessionState` from Task 2.
- Produces: store keys `powtorki:review`, `powtorki:nextDue`, `powtorki:reviewed`, `powtorki:loaded`. Nothing else reads them.

- [ ] **Step 1: Write the failing test**

Add to `app/powtorki/page.dom.test.tsx`. That file has no shared fetch helper —
each test assigns `global.fetch` itself and builds cards with its local
`card(id, promptText)` helper, whose answer text is `answer-<id>`. Follow it:

```tsx
it('resumes the same card, still revealed, and does not re-fetch the queue', async () => {
  let queueFetches = 0
  global.fetch = vi.fn((url: string) => {
    if (url === '/api/review/queue') {
      queueFetches += 1
      return Promise.resolve({
        json: () => Promise.resolve({ cards: [card('a', 'AAA'), card('b', 'BBB')], nextDue: null }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  }) as unknown as typeof fetch

  const view = render(<SessionState><ReviewPage /></SessionState>)
  await screen.findByText('AAA')
  fireEvent.click(screen.getByRole('button', { name: t.show }))
  expect(screen.getByText('answer-a')).toBeTruthy()
  expect(queueFetches).toBe(1)

  // Leave for /dodaj and come back: the provider stays, the screen does not.
  view.rerender(<SessionState><span /></SessionState>)
  view.rerender(<SessionState><ReviewPage /></SessionState>)

  expect(screen.getByText('AAA')).toBeTruthy()
  expect(screen.getByText('answer-a')).toBeTruthy()
  expect(screen.getByRole('button', { name: t.again })).toBeTruthy()
  expect(queueFetches).toBe(1)
})
```

Import `SessionState` from `@/components/SessionState` at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/powtorki/page.dom.test.tsx`
Expected: FAIL — the remount fetches again and the answer is hidden.

- [ ] **Step 3: Move the screen's state into the store**

In `app/powtorki/page.tsx`, replace the five state declarations:

```tsx
import { SessionState, useScreenReducer, useScreenState } from '@/components/SessionState'
...
const [state, dispatch] = useScreenReducer('powtorki:review', reviewReducer, initialReviewState)
const [nextDue, setNextDue] = useScreenState<number | null>('powtorki:nextDue', () => null)
const [reviewedCount, setReviewedCount] = useScreenState('powtorki:reviewed', () => 0)
const [loaded, setLoaded] = useScreenState('powtorki:loaded', () => false)
```

`rateError` stays a plain `useState`: it reports one request's outcome and must not follow you to another screen and back.

- [ ] **Step 4: Load only when there is no session to resume**

The mount effect becomes:

```tsx
// A session already in progress is resumed untouched — same card, same
// position, same revealed answer (spec §3.3). Only a screen with no session
// loads one. Cards added while you were away join your next session, not the
// middle of this one: a queue that grows behind you makes the remaining count
// jump for no visible reason.
useEffect(() => {
  if (loaded) return
  void fetch('/api/review/queue')
    .then((r) => r.json())
    .then((d) => {
      dispatch({ type: 'loaded', queue: d.cards })
      setNextDue(d.nextDue ?? null)
      setLoaded(true)
    })
}, [loaded, dispatch, setNextDue, setLoaded])
```

`shownAt` keeps being a ref reset on mount, so the duration recorded for a card you came back to is measured from the return. That is the honest reading of "how long did you look at it before rating".

- [ ] **Step 5: Run the file**

Run: `npx vitest run app/powtorki/page.dom.test.tsx`
Expected: PASS. Existing tests in the file must be wrapped in `<SessionState>` — the hooks throw outside it, which is the intended failure mode.

- [ ] **Step 6: Commit**

```bash
git add app/powtorki/page.tsx app/powtorki/page.dom.test.tsx
git commit -m "feat: resume a review session after leaving the screen"
```

---

### Task 4: `/tematy` remembers its list, its filter and its scroll

**Files:**
- Modify: `app/tematy/page.tsx:13-15` and the load effect
- Test: `app/tematy/page.dom.test.tsx`

**Interfaces:**
- Consumes: `useScreenState`, `useRestoreScroll` from Task 2.
- Produces: store keys `tematy:list`, `tematy:q`, `scroll:tematy`.

- [ ] **Step 1: Write the failing test**

The file's `stubFetch(topics)` takes the array directly and returns the calls it
saw; `row(over)` builds a topic list row. The filter input's placeholder is
`t.filterTopics`:

```tsx
it('paints the remembered list at once on return, and still re-fetches it', async () => {
  const calls = stubFetch([row()])
  const view = render(<SessionState><TopicsPage /></SessionState>)
  await screen.findByText('U lekarza')
  fireEvent.change(screen.getByPlaceholderText(t.filterTopics), { target: { value: 'lek' } })
  expect(calls.filter((c) => c.url === '/api/topics').length).toBe(1)

  view.rerender(<SessionState><span /></SessionState>)
  view.rerender(<SessionState><TopicsPage /></SessionState>)

  // Painted from the store synchronously — no await before these two.
  expect(screen.getByText('U lekarza')).toBeTruthy()
  expect((screen.getByPlaceholderText(t.filterTopics) as HTMLInputElement).value).toBe('lek')
  // ...and refreshed anyway, which is what shows a word recorded meanwhile.
  await waitFor(() => expect(calls.filter((c) => c.url === '/api/topics').length).toBe(2))
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/tematy/page.dom.test.tsx`
Expected: FAIL — the list is empty on the synchronous assertion and the filter is blank.

- [ ] **Step 3: Back the two values with the store and restore scroll**

```tsx
import { useRestoreScroll, useScreenState } from '@/components/SessionState'
...
const [topics, setTopics] = useScreenState<TopicListRow[]>('tematy:list', () => [])
const [q, setQ] = useScreenState('tematy:q', () => '')
const [error, setError] = useState<string | null>(null)
useRestoreScroll('tematy', topics.length > 0)
```

`error` stays local, like `rateError` in Task 3: a failure belongs to the visit that caused it.

The existing `load()` effect is unchanged — it still runs on every mount. That pairing is the whole freshness rule (spec §3.4): the remembered list paints, the fetch replaces it.

- [ ] **Step 4: Run the file**

Run: `npx vitest run app/tematy/page.dom.test.tsx`
Expected: PASS, with the file's existing tests wrapped in `<SessionState>`.

- [ ] **Step 5: Commit**

```bash
git add app/tematy/page.tsx app/tematy/page.dom.test.tsx
git commit -m "feat: keep the topic list and its filter across screen switches"
```

---

### Task 5: Carry a topic through the capture API and the outbox

**Files:**
- Modify: `lib/capture/pipeline.ts:31-50` (`createCapture`)
- Modify: `app/api/captures/route.ts:6-33` (POST)
- Modify: `lib/capture/outbox.ts:4-20`
- Test: `app/api/captures/route.test.ts`, `lib/capture/outbox.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createCapture(db: Db, audio: { bytes: Uint8Array; mime: string }, now: Date, lang?: DictationLang, topicId?: string | null): string`
  - `POST /api/captures` accepts an optional `topicId` form field.
  - `OutboxItem` gains `topicId?: string | null`; `enqueue` takes it.

- [ ] **Step 1: Write the failing route tests**

In `app/api/captures/route.test.ts`, extend the `upload` helper and add three cases:

```ts
function upload(lang?: string, topicId?: string) {
  const form = new FormData()
  form.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'capture.webm')
  if (lang !== undefined) form.set('lang', lang)
  if (topicId !== undefined) form.set('topicId', topicId)
  return POST(new Request('http://test/api/captures', { method: 'POST', body: form }))
}

it('files the recording into the topic it was made under', async () => {
  db.insert(topics).values({ id: 't1', name: 'Praca w IT', context: 'programowanie', suspendedAt: null, createdAt: 1, isDefault: false }).run()
  const res = await upload('pl', 't1')
  expect(res.status).toBe(202)
  expect(db.select().from(captures).get()!.topicId).toBe('t1')
})

it('stores no topic when none was sent, as before', async () => {
  await upload('pl')
  expect(db.select().from(captures).get()!.topicId).toBeNull()
})

it('refuses an unknown topic rather than misfiling the word', async () => {
  const res = await upload('pl', 'gone')
  expect(res.status).toBe(400)
  expect(db.select().from(captures).all()).toHaveLength(0)
})
```

Import `topics` alongside the other tables, and add `db.delete(topics).run()` to the `beforeEach` — leaving rows behind would make the unknown-topic case pass for the wrong reason.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run app/api/captures/route.test.ts`
Expected: FAIL — `topicId` is null in the first case and the unknown topic returns 202.

- [ ] **Step 3: Take a topic in `createCapture`**

In `lib/capture/pipeline.ts`:

```ts
export function createCapture(
  db: Db,
  audio: { bytes: Uint8Array; mime: string },
  now: Date,
  lang: DictationLang = 'pl',
  topicId: string | null = null,
): string {
  const audioMediaId = putMedia(db, { kind: 'audio', mime: audio.mime, bytes: audio.bytes, now })
  const id = randomUUID()
  db.insert(captures)
    .values({
      id,
      audioMediaId,
      transcript: null,
      status: 'uploaded',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: now.getTime(),
      lang,
      topicId,
    })
    .run()
  return id
}
```

Everything downstream already reads `capture.topicId`: `generateNewCard` passes it to `createCard`, and `meaningOf` hands the topic's context to the generator. Nothing there changes.

- [ ] **Step 4: Validate and pass it in the route**

In `app/api/captures/route.ts`, after the `lang` check:

```ts
// A sheet left open across a topic's lifetime must not silently misfile a
// word, so an unknown id is refused rather than dropped to Ogólne.
const topicField = form.get('topicId')
let topicId: string | null = null
if (typeof topicField === 'string' && topicField !== '') {
  const known = db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicField)).get()
  if (!known) return NextResponse.json({ error: 'unknown topic' }, { status: 400 })
  topicId = topicField
}
const bytes = new Uint8Array(await file.arrayBuffer())
const id = createCapture(db, { bytes, mime: file.type || 'audio/webm' }, new Date(), lang, topicId)
```

with `import { eq } from 'drizzle-orm'` and `import { topics } from '@/lib/db/schema'`.

- [ ] **Step 5: Run the route tests**

Run: `npx vitest run app/api/captures/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing outbox test**

In `lib/capture/outbox.test.ts`:

```ts
it('keeps a recording’s topic while it waits offline', async () => {
  await enqueue({ id: 'o1', bytes: new ArrayBuffer(2), mime: 'audio/webm', createdAt: 1, lang: 'pl', topicId: 't1' })
  expect((await listOutbox())[0].topicId).toBe('t1')
})
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run lib/capture/outbox.test.ts`
Expected: FAIL — TypeScript rejects `topicId` on the `enqueue` argument.

- [ ] **Step 8: Add the field**

In `lib/capture/outbox.ts`:

```ts
export type OutboxItem = {
  id: string
  bytes: ArrayBuffer
  mime: string
  createdAt: number
  attempts: number
  // Absent on entries saved before the language existed; they upload as
  // Polish.
  lang?: DictationLang
  // Absent on entries saved before topics reached this screen, and on any
  // recording made under Ogólne; both upload with no topic, which the server
  // stores as NULL and reads back as Ogólne.
  topicId?: string | null
}

export async function enqueue(
  item: Omit<OutboxItem, 'attempts' | 'lang'> & { lang: DictationLang },
): Promise<void> {
  await set(item.id, { ...item, attempts: 0 }, store)
}
```

`idb-keyval` stores plain objects with no schema version, so an entry written before this change simply has no `topicId`. No migration.

- [ ] **Step 9: Run both files**

Run: `npx vitest run lib/capture/outbox.test.ts app/api/captures/route.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/capture/pipeline.ts lib/capture/outbox.ts app/api/captures/route.ts app/api/captures/route.test.ts lib/capture/outbox.test.ts
git commit -m "feat: let a recording carry the topic it belongs to"
```

---

### Task 6: The topic row on `/dodaj`

**Files:**
- Modify: `app/dodaj/page.tsx` (state, `drain`, `onRecorded`, the fixed bottom bar)
- Modify: `i18n/pl.ts`
- Test: `app/dodaj/page.dom.test.tsx`

**Interfaces:**
- Consumes: `useScreenState` and `useRestoreScroll` (Task 2); `enqueue`'s `topicId` and the route's `topicId` field (Task 5); `DEFAULT_TOPIC_ID` from `@/lib/topics/default`; `Sheet` from `@/components/ui/Sheet`.
- Produces: store keys `dodaj:topic` (holding `{ id: string; name: string }`) and `scroll:dodaj`.

- [ ] **Step 1: Add the Polish strings**

In `i18n/pl.ts`:

```ts
recordingTopic: 'temat',
defaultTopic: 'Ogólne',
resetTopic: 'wróć do Ogólne',
chooseTopic: 'Wybierz temat',
```

- [ ] **Step 2: Write the failing tests**

In `app/dodaj/page.dom.test.tsx`. That file stubs `fetch`, `MediaRecorder` and
the microphone per describe-block and fires real pointer events; add one
helper beside the existing ones so these three tests can hold a button and
read what was uploaded:

```tsx
function stubScreen(topics: unknown[] = []) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url.startsWith('/api/topics') ? { topics } : { captures: [] }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }) as unknown as Promise<Response>
  }))
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  stubMic()
  return calls
}

async function holdPolish() {
  const button = screen.getByRole('button', { name: t.recordPolish })
  await act(async () => { fireEvent.pointerDown(button) })
  await act(async () => { fireEvent.pointerUp(button) })
}

const chooseTopic = `${t.recordingTopic}: ${t.defaultTopic}`
```

```tsx
describe('AddPage topic row', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('starts on Ogólne, with no reset button to hit by accident', () => {
    stubScreen()
    render(<SessionState><AddPage /></SessionState>)
    expect(screen.getByRole('button', { name: chooseTopic })).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.resetTopic })).toBeNull()
  })

  it('sends the chosen topic with the recording, and resets in one tap', async () => {
    const calls = stubScreen([{ id: 't1', name: 'Praca w IT', suspendedAt: null }])
    render(<SessionState><AddPage /></SessionState>)

    fireEvent.click(screen.getByRole('button', { name: chooseTopic }))
    fireEvent.click(await screen.findByRole('button', { name: 'Praca w IT' }))
    await holdPolish()

    await waitFor(() => {
      const upload = calls.find((c) => c.url === '/api/captures' && c.init?.method === 'POST')
      expect((upload!.init!.body as FormData).get('topicId')).toBe('t1')
    })

    fireEvent.click(screen.getByRole('button', { name: t.resetTopic }))
    expect(screen.getByRole('button', { name: chooseTopic })).toBeTruthy()
  })

  it('sends no topic at all under Ogólne, keeping today’s NULL row', async () => {
    const calls = stubScreen()
    render(<SessionState><AddPage /></SessionState>)
    await holdPolish()
    await waitFor(() => {
      const upload = calls.find((c) => c.url === '/api/captures' && c.init?.method === 'POST')
      expect((upload!.init!.body as FormData).get('topicId')).toBeNull()
    })
  })

  it('keeps the chosen topic across a trip to another screen', async () => {
    stubScreen([{ id: 't1', name: 'Praca w IT', suspendedAt: null }])
    const view = render(<SessionState><AddPage /></SessionState>)
    fireEvent.click(screen.getByRole('button', { name: chooseTopic }))
    fireEvent.click(await screen.findByRole('button', { name: 'Praca w IT' }))

    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><AddPage /></SessionState>)

    expect(screen.getByRole('button', { name: `${t.recordingTopic}: Praca w IT` })).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run app/dodaj/page.dom.test.tsx`
Expected: FAIL — there is no topic trigger on the screen.

- [ ] **Step 4: Hold the chosen topic in the store**

In `app/dodaj/page.tsx`:

```tsx
import { useScreenState } from '@/components/SessionState'
import { Sheet } from '@/components/ui/Sheet'
import { X } from '@/components/ui/icons'
import { DEFAULT_TOPIC_ID } from '@/lib/topics/default'

type ChosenTopic = { id: string; name: string }
const OGOLNE: ChosenTopic = { id: DEFAULT_TOPIC_ID, name: t.defaultTopic }
...
const [topic, setTopic] = useScreenState<ChosenTopic>('dodaj:topic', () => OGOLNE)
const [pickerOpen, setPickerOpen] = useState(false)
const [topicQuery, setTopicQuery] = useState('')
const [topicList, setTopicList] = useState<{ id: string; name: string | null }[]>([])
```

and, once `chips` is computed further down the component, restore the waterfall's
position (spec §3.2):

```tsx
useRestoreScroll('dodaj', chips.length > 0)
```

The chips themselves are deliberately not remembered: they are re-polled from
the server and the outbox on mount, which is both cheap and fresher than
anything the store could hold.

The picker's open state and its search text stay local: a half-open sheet is not a place worth returning to.

- [ ] **Step 5: Send the topic with each recording**

`onRecorded` enqueues it, and `drain` puts it on the upload — a recording keeps the topic it was *made* under even if you switch topics while it is still queued offline:

```tsx
const onRecorded = useCallback(
  async (bytes: ArrayBuffer, mime: string, lang: DictationLang) => {
    await enqueue({
      id: crypto.randomUUID(),
      bytes,
      mime,
      createdAt: Date.now(),
      lang,
      // Ogólne is sent as no topic at all, so the row keeps the NULL that
      // `topicView` and `listTopics` already read as Ogólne.
      topicId: topic.id === DEFAULT_TOPIC_ID ? null : topic.id,
    })
    ...unchanged...
  },
  [drain, topic],
)
```

and inside `drain`'s upload callback, beside the existing `lang` line:

```tsx
if (item.topicId) form.set('topicId', item.topicId)
```

- [ ] **Step 6: Draw the row and the sheet**

Inside the existing fixed bottom bar, as the first child (above the `holdToRecord` caption), plus the sheet as a sibling of that bar:

```tsx
<div className="flex w-full items-center justify-center gap-1">
  <button
    type="button"
    onClick={() => { setTopicQuery(''); void openPicker() }}
    className="inline-flex min-h-8 items-center rounded-full px-3 text-sm text-neutral-600 underline"
  >
    {`${t.recordingTopic}: ${topic.name}`}
  </button>
  {topic.id !== DEFAULT_TOPIC_ID && (
    <button
      type="button"
      aria-label={t.resetTopic}
      onClick={() => setTopic(OGOLNE)}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center"
    >
      <Icon icon={X} size={16} />
    </button>
  )}
</div>
```

```tsx
<Sheet open={pickerOpen} label={t.chooseTopic} onClose={() => setPickerOpen(false)}>
  <input
    value={topicQuery}
    onChange={(e) => setTopicQuery(e.target.value)}
    placeholder={t.filterTopics}
    className="w-full rounded-lg border border-neutral-300 px-3 py-3"
  />
  <ul>
    {pickable.map((x) => (
      <li key={x.id}>
        <button
          type="button"
          onClick={() => { setTopic({ id: x.id, name: x.name ?? t.unnamedTopic }); setPickerOpen(false) }}
          className="w-full border-b py-3 text-left text-row"
        >
          {x.name ?? t.unnamedTopic}
        </button>
      </li>
    ))}
  </ul>
</Sheet>
```

with the list fetched on open, as `MoveToTopic` does, and Ogólne pinned to the top:

```tsx
// Fetched on every open so a topic renamed since the screen loaded is never
// shown stale. Ogólne is pinned first: it is the way back out of a topic and
// must not need scrolling or typing to reach.
async function openPicker() {
  try {
    const res = await fetch('/api/topics')
    if (!res.ok) throw new Error()
    const body = (await res.json()) as { topics: { id: string; name: string | null; suspendedAt: number | null }[] }
    setTopicList(body.topics)
  } catch {
    setTopicList([])
  }
  setPickerOpen(true)
}

const search = topicQuery.trim().toLowerCase()
const named = topicList.map((x) => ({ ...x, name: x.name ?? t.unnamedTopic }))
const pickable = [
  ...named.filter((x) => x.id === DEFAULT_TOPIC_ID),
  ...named.filter((x) => x.id !== DEFAULT_TOPIC_ID),
].filter((x) => x.id !== topic.id && x.name.toLowerCase().includes(search))
```

Bump the chip list's bottom padding from `pb-60` to `pb-72` for the taller bar.

- [ ] **Step 7: Run the file**

Run: `npx vitest run app/dodaj/page.dom.test.tsx`
Expected: PASS, with the file's existing tests wrapped in `<SessionState>`.

- [ ] **Step 8: Commit**

```bash
git add app/dodaj/page.tsx app/dodaj/page.dom.test.tsx i18n/pl.ts
git commit -m "feat: record straight into a chosen topic"
```

---

### Task 7: A hand-typed word becomes a card

**Files:**
- Modify: `lib/topics/service.ts` (`cardItem`, new `addManualCard`)
- Create: `app/api/topics/[id]/cards/route.ts`
- Delete: `app/api/topics/[id]/items/route.ts`
- Test: `lib/topics/service.test.ts`, `app/api/topics/items.route.test.ts`

**Interfaces:**
- Consumes: the existing `addManualItem` and `cardItem`.
- Produces:
  - `addManualCard(db: Db, topicId: string, text: string, now: Date): { ok: true; item: ItemView; captureId: string } | { ok: false; reason: 'empty' | 'not-found' } | { ok: false; reason: 'in-topic' } | { ok: false; reason: 'in-deck'; topicName: string }`
  - `POST /api/topics/[id]/cards` with body `{ text: string }`, replacing `POST /api/topics/[id]/items`.

- [ ] **Step 1: Write the failing service tests**

In `lib/topics/service.test.ts`:

```ts
describe('addManualCard', () => {
  it('adds the word and cards it in one go', () => {
    const { db } = createTestDb()
    topic(db)
    const result = addManualCard(db, 't1', 'recepta', NOW)
    expect(result.ok).toBe(true)

    const row = db.select().from(topicItems).where(eq(topicItems.answerPl, 'recepta')).get()!
    expect(row.status).toBe('carded')
    expect(row.source).toBe('manual')
    expect(row.captureId).toBe((result as { captureId: string }).captureId)

    const capture = db.select().from(captures).get()!
    expect(capture.transcript).toBe('recepta')
    expect(capture.topicId).toBe('t1')
    expect(capture.status).toBe('queued')
    expect(db.select().from(generationJobs).get()!.kind).toBe('new')
  })

  it('refuses a word already in this topic, writing nothing', () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'recepta')
    expect(addManualCard(db, 't1', 'Recepta', NOW)).toEqual({ ok: false, reason: 'in-topic' })
    expect(db.select().from(captures).all()).toHaveLength(0)
  })

  it('refuses a word already in the deck, naming its topic', () => {
    const { db } = createTestDb()
    topic(db)
    card(db, 'kot')
    expect(addManualCard(db, 't1', 'Kot', NOW)).toEqual({ ok: false, reason: 'in-deck', topicName: 'Ogólne' })
    expect(db.select().from(captures).all()).toHaveLength(0)
  })

  it('refuses an unknown topic and an empty word', () => {
    const { db } = createTestDb()
    expect(addManualCard(db, 'nope', 'recepta', NOW)).toEqual({ ok: false, reason: 'not-found' })
    topic(db)
    expect(addManualCard(db, 't1', '   ', NOW)).toEqual({ ok: false, reason: 'empty' })
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/topics/service.test.ts`
Expected: FAIL — `addManualCard` is not exported.

- [ ] **Step 3: Split `cardItem`'s body out of its transaction**

So the new function can reuse it without nesting a transaction inside another one:

```ts
/** `+ karta`'s body, without a transaction of its own: see `cardItem` and `addManualCard`. */
function cardOpenItem(tx: Db, topicId: string, itemId: string, now: Date): { captureId: string } | null {
  const item = tx
    .select()
    .from(topicItems)
    .where(and(eq(topicItems.id, itemId), eq(topicItems.topicId, topicId), eq(topicItems.status, 'open')))
    .get()
  if (!item) return null
  const captureId = randomUUID()
  tx.insert(captures)
    .values({
      id: captureId,
      audioMediaId: null,
      transcript: item.answerPl,
      status: 'queued',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: now.getTime(),
      transcribedAt: null,
      duplicateOf: null,
      topicId,
      glossRu: item.glossRu,
      lang: null,
    })
    .run()
  enqueueJob(tx, { kind: 'new', captureId }, now)
  tx.update(topicItems).set({ status: 'carded', captureId }).where(eq(topicItems.id, itemId)).run()
  return { captureId }
}

/** `+ karta` on an open item (spec 2026-09-19-topic-items §4.1). */
export function cardItem(db: Db, topicId: string, itemId: string, now: Date): { captureId: string } | null {
  return db.transaction((tx) => cardOpenItem(tx as unknown as Db, topicId, itemId, now))
}
```

- [ ] **Step 4: Write `addManualCard`**

```ts
/**
 * A word typed on the topic page's hand-add bar (spec 2026-09-22 §6.3): added
 * and carded in one transaction, so a refusal leaves nothing behind and a
 * crash between the two cannot strand an open item nobody asked for.
 *
 * The item row is kept rather than skipped straight to a capture: it is what
 * makes the "already in this topic" check work, and `linkItem` fills in its
 * card id when generation finishes, exactly as for `+ karta`.
 */
export function addManualCard(
  db: Db,
  topicId: string,
  text: string,
  now: Date,
):
  | { ok: true; item: ItemView; captureId: string }
  | { ok: false; reason: 'empty' | 'not-found' }
  | { ok: false; reason: 'in-topic' }
  | { ok: false; reason: 'in-deck'; topicName: string } {
  return db.transaction((tx) => {
    const added = addManualItem(tx as unknown as Db, topicId, text, now)
    if (!added.ok) return added
    const carded = cardOpenItem(tx as unknown as Db, topicId, added.item.id, now)
    // Unreachable in practice — the row was just inserted as `open` in this
    // same transaction — but returning rather than asserting keeps a future
    // change to addManualItem from becoming a crash on this path.
    if (!carded) return { ok: false, reason: 'not-found' } as const
    return { ok: true, item: added.item, captureId: carded.captureId }
  })
}
```

- [ ] **Step 5: Run the service tests**

Run: `npx vitest run lib/topics/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Move the route's tests to `/cards`**

Two changes in `app/api/topics/items.route.test.ts`.

First, its `addItem` helper seeds open items for the *other* route blocks
(`/card`, `/discard`, `/restore`) by calling the items route — which this task
deletes. Point the helper at the service instead, so those blocks keep getting
plain open items:

```ts
const { addManualItem } = await import('@/lib/topics/service')

function addItem(topicId: string, text: string) {
  const result = addManualItem(db, topicId, text, NOW)
  if (!result.ok) throw new Error(`seeding ${text} failed: ${result.reason}`)
  return result.item.id
}
```

It is no longer async; drop the `await` at its four call sites, or keep them —
`await` on a non-promise is harmless, but removing them is tidier.

Second, replace the `POST /api/topics/:id/items` block with the same five
cases against the new route. The statuses and the two Polish messages are the
contract and do not change; only the route and the 201 → 202 do:

```ts
const cardsRoute = await import('./[id]/cards/route')

describe('POST /api/topics/:id/cards', () => {
  it('adds a hand-typed word and cards it', async () => {
    const id = makeTopic('t4')
    const res = await cardsRoute.POST(post({ text: 'wesele' }), params({ id }))
    expect(res.status).toBe(202)
    const { item, captureId } = (await res.json()) as { item: { id: string; answerPl: string; source: string }; captureId: string }
    expect(item).toMatchObject({ answerPl: 'wesele', source: 'manual' })
    expect(captureId).toEqual(expect.any(String))
    expect(db.select().from(topicItems).where(eq(topicItems.id, item.id)).get()).toMatchObject({
      status: 'carded',
      captureId,
    })
    expect(db.select().from(captures).where(eq(captures.id, captureId)).get()).toMatchObject({
      transcript: 'wesele',
      topicId: id,
      status: 'queued',
    })
  })

  it('refuses an empty text with 400', async () => {
    const id = makeTopic('t5')
    const res = await cardsRoute.POST(post({ text: '   ' }), params({ id }))
    expect(res.status).toBe(400)
  })

  it('is 404 for an unknown topic', async () => {
    const res = await cardsRoute.POST(post({ text: 'wesele' }), params({ id: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('refuses a word the topic already holds with 409', async () => {
    const id = makeTopic('t6')
    addItem(id, 'wesele')
    const res = await cardsRoute.POST(post({ text: 'wesele' }), params({ id }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'już jest w tym temacie' })
  })

  it('refuses a word already in the deck with 409, naming its topic', async () => {
    const id = makeTopic('t7')
    const deckTopic = makeTopic('t8', { name: 'U lekarza' })
    seedCard({ id: 'c1', answerPl: 'złośliwy', answerKey: 'złośliwy', topicId: deckTopic })
    const res = await cardsRoute.POST(post({ text: 'złośliwy' }), params({ id }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'już masz — w temacie U lekarza' })
  })
})
```

Finally drop the `const itemsRoute = await import('./[id]/items/route')` line at
the top of the file.

- [ ] **Step 7: Run them and watch them fail**

Run: `npx vitest run app/api/topics/items.route.test.ts`
Expected: FAIL — cannot resolve `./[id]/cards/route`.

- [ ] **Step 8: Write the route and delete the old one**

Create `app/api/topics/[id]/cards/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { addManualCard } from '@/lib/topics/service'

const Body = z.object({ text: z.string() })

/** The hand-add bar on `z kartą` (spec 2026-09-22 §6.3): a typed word becomes a card. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad item' }, { status: 400 })
  const result = addManualCard(db, id, body.data.text, new Date())
  if (result.ok) return NextResponse.json({ item: result.item, captureId: result.captureId }, { status: 202 })
  switch (result.reason) {
    case 'empty':
      return NextResponse.json({ error: 'empty' }, { status: 400 })
    case 'not-found':
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    case 'in-topic':
      return NextResponse.json({ error: 'już jest w tym temacie' }, { status: 409 })
    case 'in-deck':
      return NextResponse.json({ error: `już masz — w temacie ${result.topicName}` }, { status: 409 })
  }
}
```

Then `git rm app/api/topics/[id]/items/route.ts`. The topic page is its only caller and Task 8 moves it over; `addManualItem` stays as the primitive underneath, with its own tests.

- [ ] **Step 9: Run the route tests and the suite**

Run: `npx vitest run app/api/topics/items.route.test.ts && npm test`
Expected: PASS. Task 8 has not landed yet, so the topic page still posts to the deleted route — that shows up as a `/tematy/[id]` dom test failure only if a test asserts the URL; fix it in Task 8, not here, and note it if it appears.

- [ ] **Step 10: Commit**

```bash
git add lib/topics/service.ts lib/topics/service.test.ts \
        "app/api/topics/[id]/cards/route.ts" app/api/topics/items.route.test.ts
git add -A "app/api/topics/[id]/items/route.ts"   # records the deletion
git commit -m "feat: turn a typed word into a card in one step"
```

---

### Task 8: The hand-add bar moves, loses its microphones, and collapses

**Files:**
- Modify: `components/ManualAddBar.tsx` (rewrite)
- Modify: `components/ManualAddBar.dom.test.tsx`
- Modify: `app/tematy/[id]/page.tsx`
- Modify: `app/tematy/[id]/page.dom.test.tsx`
- Modify: `i18n/pl.ts`

**Interfaces:**
- Consumes: `useScreenState`, `useRestoreScroll` (Task 2); `POST /api/topics/[id]/cards` (Task 7).
- Produces: `ManualAddBar({ value, onChange, onAdd, onClose })` where `onAdd: (text: string) => Promise<string | null>` returns an error message or null; store keys `tematy:<id>:draft`, `tematy:<id>:adding`, `scroll:tematy:<id>`.

- [ ] **Step 1: Update the Polish placeholder**

In `i18n/pl.ts`, `manualPlaceholder` no longer mentions recording:

```ts
manualPlaceholder: 'wpisz słowo lub frazę…',
```

- [ ] **Step 2: Write the failing bar tests**

Replace the mic cases in `components/ManualAddBar.dom.test.tsx` — they are testing behaviour that is leaving:

```tsx
it('has no microphones: dictation goes through the recording screen', () => {
  render(<ManualAddBar value="" onChange={() => {}} onAdd={async () => null} onClose={() => {}} />)
  expect(screen.queryByRole('button', { name: t.recordPolish })).toBeNull()
  expect(screen.queryByRole('button', { name: t.recordRussian })).toBeNull()
})

it('reports what the server refused', async () => {
  render(<ManualAddBar value="kot" onChange={() => {}} onAdd={async () => 'już masz — w temacie Ogólne'} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: t.addItem }))
  expect(await screen.findByText('już masz — w temacie Ogólne')).toBeTruthy()
})

it('closes without adding when cancelled', () => {
  const onClose = vi.fn()
  const onAdd = vi.fn()
  render(<ManualAddBar value="kot" onChange={() => {}} onAdd={onAdd} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: t.cancel }))
  expect(onClose).toHaveBeenCalled()
  expect(onAdd).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run components/ManualAddBar.dom.test.tsx`
Expected: FAIL — the component still owns its own text state and still renders mic buttons.

- [ ] **Step 4: Rewrite the bar**

`components/ManualAddBar.tsx` becomes, in full:

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Plus, X } from '@/components/ui/icons'
import { t } from '@/i18n/pl'

/**
 * Adding a word to a topic by hand (spec 2026-09-22 §6.1): text only, on the
 * `z kartą` tab, and what you type becomes a card. Dictation left this bar
 * for the recording screen, which now has a topic of its own to file into.
 *
 * The draft lives in the caller, not here: it belongs to the topic page's
 * remembered state, so a trip to /dodaj and back does not eat a half-typed
 * word.
 */
export function ManualAddBar({
  value,
  onChange,
  onAdd,
  onClose,
}: {
  value: string
  onChange: (text: string) => void
  onAdd: (text: string) => Promise<string | null>
  onClose: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function add() {
    const trimmed = value.trim()
    if (!trimmed) return
    setBusy(true)
    const error = await onAdd(trimmed)
    setBusy(false)
    setMessage(error)
    // The bar stays open on success, cleared and focused: adding a run of
    // words is the reason it exists. A refusal keeps the word on screen so it
    // can be edited rather than retyped.
    if (!error) onChange('')
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <input
        ref={inputRef}
        aria-label={t.manualAdd}
        placeholder={t.manualPlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-base"
      />
      <div className="flex items-center gap-2">
        <span className="ml-auto flex gap-2">
          <Button variant="primary" icon={Plus} label={t.addItem} disabled={value.trim() === ''} busy={busy} onClick={() => void add()} />
          <Button variant="icon" icon={X} label={t.cancel} onClick={onClose} />
        </span>
      </div>
      {message && <p className="text-sub text-red-600">{message}</p>}
    </div>
  )
}
```

- [ ] **Step 5: Run the bar's tests**

Run: `npx vitest run components/ManualAddBar.dom.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing topic-page tests**

In `app/tematy/[id]/page.dom.test.tsx`:

```tsx
it('offers the hand-add on z kartą, not on bez karty', async () => {
  stubFetch(() => view())
  render(<SessionState><TopicPage /></SessionState>)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabOpen) }))
  expect(screen.queryByRole('button', { name: t.manualAdd })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: new RegExp(t.tabCarded) }))
  expect(screen.getByRole('button', { name: t.manualAdd })).toBeTruthy()
})

it('keeps the bar shut until + is tapped, and posts to /cards', async () => {
  const calls = stubFetch(() => view(), { 'POST /api/topics/t1/cards': { status: 202, body: { item: item('i4', 'recepta'), captureId: 'c1' } } })
  render(<SessionState><TopicPage /></SessionState>)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
  expect(screen.queryByLabelText(t.manualAdd)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
  fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'recepta' } })
  fireEvent.click(screen.getByRole('button', { name: t.addItem }))

  await waitFor(() =>
    expect(writes(calls)).toContainEqual({ url: '/api/topics/t1/cards', method: 'POST', body: { text: 'recepta' } }),
  )
})

it('keeps a half-typed word across a trip to another screen', async () => {
  stubFetch(() => view())
  const page = render(<SessionState><TopicPage /></SessionState>)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
  fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
  fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'recep' } })

  page.rerender(<SessionState><span /></SessionState>)
  page.rerender(<SessionState><TopicPage /></SessionState>)

  expect((await screen.findByLabelText(t.manualAdd) as HTMLInputElement).value).toBe('recep')
})
```

- [ ] **Step 7: Run them and watch them fail**

Run: `npx vitest run app/tematy/[id]/page.dom.test.tsx`
Expected: FAIL — the bar is still on `bez karty`, always visible, and posts to `/items`.

- [ ] **Step 8: Wire the topic page**

In `app/tematy/[id]/page.tsx`:

```tsx
import { useRestoreScroll, useScreenState } from '@/components/SessionState'
import { Icon } from '@/components/ui/Icon'
import { Plus } from '@/components/ui/icons'
...
const [draft, setDraft] = useScreenState(`tematy:${id}:draft`, () => '')
const [adding, setAdding] = useScreenState(`tematy:${id}:adding`, () => false)
useRestoreScroll(`tematy:${id}`, view !== null)
```

The active tab is the one thing here that already survives a remount: the page
reads it back through `storedTab(id)` from `localStorage`, which predates this
work. Leave that exactly as it is — spec §3.2 counts it as remembered, and
adding a second mechanism for one value would only give the two a chance to
disagree.

`addItem` posts to the new route:

```tsx
async function addItem(text: string): Promise<string | null> {
  const error = await send(`/api/topics/${id}/cards`, 'POST', { text })
  await load()
  return error
}
```

`send` already turns a 409 into its Polish message and anything else into `t.topicSaveFailed`; a 202 is `res.ok`, so it needs no change.

Remove `<ManualAddBar onAdd={addItem} />` from the `open` branch. In the `carded` branch, render the bar when open and the `+` band when not — the band copies `/tematy`'s pointer-events pattern, without which it swallows taps on the card rows beneath it:

```tsx
{tab === 'carded' && (
  <div className="flex flex-col gap-4">
    {adding && (
      <ManualAddBar
        value={draft}
        onChange={setDraft}
        onAdd={addItem}
        onClose={() => { setDraft(''); setAdding(false) }}
      />
    )}
    <CardedTab topicId={id} cards={groups.carded} pending={pending} topicSuspended={topic.suspendedAt !== null} busy={busy} act={act} />
    {!adding && (
      <div className="above-tabbar pointer-events-none fixed inset-x-0 z-10">
        <div className="mx-auto flex max-w-xl justify-end px-4 pb-4">
          <button
            type="button"
            aria-label={t.manualAdd}
            title={t.manualAdd}
            onClick={() => setAdding(true)}
            className="pointer-events-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg"
          >
            <Icon icon={Plus} size={24} />
          </button>
        </div>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 9: Run the file**

Run: `npx vitest run app/tematy/[id]/page.dom.test.tsx`
Expected: PASS, with the file's existing tests wrapped in `<SessionState>` and the old `/items` assertions retargeted at `/cards`.

- [ ] **Step 10: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all PASS. The build matters here: it is the only check that the Sheet and the store survive a production compile.

- [ ] **Step 11: Commit**

```bash
git add components/ManualAddBar.tsx components/ManualAddBar.dom.test.tsx "app/tematy/[id]/page.tsx" "app/tematy/[id]/page.dom.test.tsx" i18n/pl.ts
git commit -m "feat: collapse the hand-add bar onto z kartą as a text-only add"
```

---

## Manual check before calling it done

The suite cannot see layout, and three of these changes are about where a thumb lands. On a phone-sized viewport (`npm run dev`, DevTools at 390×844):

1. `/dodaj` — the topic row sits above the caption, the mic buttons are still fully visible, and the last chip can be scrolled clear of the bar.
2. `/tematy/[id]` on `z kartą` — the `+` does not cover the last card row, and tapping a row underneath the band still opens it.
3. Record a word into a topic, wait for the chip to clear, open `tematy` → the word is in that topic; go back to `dodaj` → the topic is still selected.
4. Start a review, reveal an answer, switch to `tematy` and back → the same card, still revealed.
