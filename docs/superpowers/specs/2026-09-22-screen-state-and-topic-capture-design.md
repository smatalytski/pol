# Fiszki — remembered screens, and dictating straight into a topic

Date: 2026-09-22
Status: approved in conversation, awaiting written-spec review

## 1. What changes, in one paragraph

Four UI changes and one structural one, all driven by one session shape:
recording a run of words into one topic, and hopping between `powtórki`,
`dodaj` and `tematy` while doing it.

- **Screen state survives navigation.** A session store above the routes keeps
  each screen's place, so a trip to another tab and back returns you where you
  left off instead of to a freshly mounted screen.
- **`/dodaj` chooses a topic.** A `temat: …` row above the recording buttons
  files every recording made after it into that topic, with a one-tap reset to
  Ogólne.
- **The tab bar swaps `fiszki` and `tematy`**, putting tematy in the thumb zone
  beside dodaj.
- **The topic page's hand-add moves to `z kartą`**, loses its microphone
  buttons, and collapses behind a `+` button. What you type there becomes a
  card directly.
- **Out of scope:** dark mode; remembering anything across a reload (§2);
  showing un-approved captures on the topic page (§4.5); how batch suggestions
  reach `bez karty`, which is unchanged.

Together these give the fifth thing asked for — a word recorded on `/dodaj` is
visible in its topic when you navigate there — which follows from the first two
changes plus the freshness rule in §3.4 rather than needing work of its own.

## 2. Decisions

- **The store holds where you were, never what is true** (§3.4). Server data is
  re-fetched on every return; the remembered copy exists only so the screen
  paints instantly instead of flashing empty.
- **`powtórki` is the deliberate exception**: its position *is* its data, so a
  return mid-session re-uses the loaded queue and does not re-fetch.
- **State lives in memory only**, not in `sessionStorage`. A reload starts
  fresh. Chosen over persistence because every restored value would otherwise
  need re-validating against the server (a remembered card may no longer be
  due), which is a second system for a case — the PWA being evicted mid-session
  — that costs one tap to recover from.
- **The routes stay as they are.** Collapsing the three screens into one route
  would keep DOM state for free but would cost `/tematy/[id]` deep links, the
  back button and `aria-current`, and would leave two polling intervals and a
  wake lock running on screens that are not visible.
- **A hand-typed word becomes a card immediately**, rather than an open item
  you card later. Voice and text now reach the same place by different doors.
- **The topic chosen on `/dodaj` is not remembered across a reload**, like
  every other value in the store. It is safe to reset because the trigger sits
  directly above the button you are about to hold — the current topic is never
  hidden from the act it affects.

## 3. The session store

### 3.1 Shape

`components/SessionState.tsx` is a client provider mounted in `app/layout.tsx`,
wrapping `{children}`. Because a root layout is not unmounted on a client
navigation, anything it holds outlives every tab switch.

It holds one plain `Map` in a ref — screen key to that screen's remembered
state — and never re-renders. Screens reach it through hooks shaped like the
ones they already use:

```ts
/** Drop-in for useState: seeded from the store, written back on change. */
export function useScreenState<T>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>]

/** Drop-in for useReducer, for /powtorki's existing reviewReducer. */
export function useScreenReducer<S, A>(key: string, reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>]

/** Records scrollY as you scroll; restores it once `ready` says there is content to scroll. */
export function useRestoreScroll(key: string, ready: boolean): void
```

Each hook keeps local `useState`/`useReducer` for rendering and mirrors the
value into the Map. Re-renders therefore stay inside the screen that changed:
nothing above the routes re-renders, and the context value is stable for the
life of the app.

`useRestoreScroll` must not restore on mount alone. `/tematy` fetches its list
asynchronously, so at mount the page is still short and a restore would be
clamped to 0; hence the `ready` argument — the restore runs in a layout effect
gated on the screen having rendered its content, and runs at most once per
mount. The position itself is recorded from a passive `scroll` listener
straight into the Map, not read at unmount, so it cannot be lost to a
navigation that scrolls the window before the screen tears down.

### 3.2 What each screen keeps

| Screen | Remembered | Re-fetched on return |
|---|---|---|
| `/powtorki` | queue, position, `revealed`, `lastRated`, session count, `nextDue`, `loaded` | nothing (§3.3) |
| `/dodaj` | chosen topic, scroll | chips — already polled from the server and the outbox |
| `/tematy` | list, search text, scroll | the list, seeded from the store first |
| `/tematy/[id]` | active tab, add-bar draft, whether the bar is open, scroll — keyed per topic id | the topic view |

Keys are per screen, and per topic id for `/tematy/[id]`, so two topics never
share a draft.

### 3.3 `/powtorki` resumes exactly

Today the queue fetch runs in a mount effect with an empty dependency list.
With the reducer moved into the store, that effect becomes conditional on
`loaded`: a session already in progress is resumed untouched — same card, same
position, and the answer still revealed if it was — and only a screen with no
session loads one.

Cards added while you were away join the queue on your next session, not
mid-stream. That is the point: a queue that grows behind you while you are
halfway through a card makes the remaining count jump for no visible reason.

### 3.4 Remembering versus freshness

Remembering and staleness are the same mechanism seen from two sides, and item
5 of the request — record a word, go to `tematy`, expect to see it — is exactly
the case where staleness would show. The rule:

- The remembered list is painted immediately on mount, so there is no blank
  flash and no spinner on a screen you were just looking at.
- A fetch is issued on that same mount, and its result replaces the remembered
  copy.

So the screen looks unchanged at the instant you arrive and is correct a moment
later. `/powtorki` is the one screen that skips the fetch, per §3.3.

## 4. `/dodaj` — recording into a topic

### 4.1 The topic row

The existing fixed bottom bar gains a row above its caption and mic buttons:

```
                temat: Praca w IT   ✕
                   przytrzymaj, aby nagrać
                      ( PL )   ( RU )
```

- The trigger reads `temat: <name>` and opens a full-screen `Sheet` — the same
  overlay `/sluchaj` uses for its topic picker — with a search field and the
  topic list. The list is fetched on open, as `MoveToTopic` does, so a topic
  renamed since the page loaded can never be shown stale. **Ogólne is pinned to
  the top of the list**, so the way back is short even with the sheet open.
- The `✕` sets the topic back to Ogólne in one tap without opening the sheet.
  It is rendered only when the current topic is not Ogólne, so a fresh load has
  nothing extra to hit by accident. 32px tap target, matching `/sluchaj`'s
  chips.
- The choice starts at Ogólne on load and lives in the session store, so it
  survives tab switches and applies to every recording made after it.

The chip list's bottom padding grows by the height of the new row.

New strings in `i18n/pl.ts` for the sheet's title and the reset button's
accessible label.

### 4.2 `POST /api/captures`

Gains an optional `topicId` form field beside the existing `lang`.

- Absent: the capture is stored with `topic_id` NULL, exactly as today, and
  belongs to Ogólne by the rule `topicView` already implements.
- Present and unknown: **400**. A sheet left open across a topic's lifetime
  must not silently misfile a word.
- Present and known: written to the `topic_id` column, which already exists.

`createCapture(db, audio, now, lang)` takes the topic id alongside `lang`.

### 4.3 The outbox

`OutboxItem` gains an optional `topicId`, in the same shape `lang` already has:
an entry saved before this change has none and uploads as Ogólne. `idb-keyval`
stores plain objects with no schema version, so no migration is involved. A
recording made offline keeps its topic when it finally uploads.

### 4.4 What the existing pipeline then does

Both consequences fall out of code that is already there, and neither needs a
change:

- `generateNewCard` passes `capture.topicId` to `createCard`, so the finished
  card lands in that topic's `z kartą`.
- `meaningOf` reads the topic's `context` and hands it to the generator, so a
  word dictated into *Praca w IT* is generated in that sense rather than its
  most common one. **This is a real behaviour change for dictated cards.** It
  is the intended kind, and Ogólne — which has no context — behaves exactly as
  today.

### 4.5 The ten-second seam

A capture reaches the topic page's `pending` list only once it is approved and
queued. During its ten-second review window it is on `/dodaj` and not yet in
the topic. Tapping `zatwierdź` on the chip promotes it immediately, so the wait
only applies to a recording left alone.

`topicView` is deliberately not taught about un-approved captures: ten seconds
is short, and the current rule — a topic shows what has been committed to it —
is coherent as it stands.

## 5. The tab bar

`TABS` in `components/TabBar.tsx` swaps its `fiszki` and `tematy` entries:

```
powtórki · słuchaj · dodaj · tematy · fiszki · ustawienia
```

Tematy moves next to dodaj, where the thumb is; nothing else about the bar
changes. The order assertion in `TabBar.dom.test.tsx` moves with it.

## 6. The topic page's hand-add

### 6.1 It moves, and loses its microphones

`ManualAddBar` moves from the `bez karty` tab to `z kartą`, and keeps only its
text input, `dodaj` and `✕`. The PL/RU hold buttons, the `useHoldToRecord`
wiring and the `/api/topics/transcribe` call are removed from it: dictation is
the recording screen's job now, and §4 gives it a topic to land in.

`/api/topics/transcribe` itself stays — `/tematy/nowy` still records a topic's
context with it.

`bez karty` keeps its suggested items, their `+ karta` buttons, and the batch
controls. Only the hand-add leaves it.

### 6.2 Collapsed behind `+`

The bar is hidden by default. A round `+` button is fixed at the bottom right
above the tab bar — the shape `/tematy` already uses for `nowy temat`. Tapping
it expands the bar and focuses the input; `✕` collapses it and clears the
draft.

Whether the bar is open, and what is typed in it, live in the session store
keyed by topic id (§3.2), so a trip to `/dodaj` and back does not eat a
half-typed word.

### 6.3 A typed word becomes a card

```ts
/** A hand-typed word, added and carded in one go (this spec §6.3). */
export function addManualCard(db: Db, topicId: string, text: string, now: Date):
  | { ok: true; item: ItemView; captureId: string }
  | { ok: false; reason: 'empty' | 'not-found' }
  | { ok: false; reason: 'in-topic' }
  | { ok: false; reason: 'in-deck'; topicName: string }
```

One transaction over the two functions that already exist: `addManualItem`
inserts the row and performs the duplicate checks that produce *już jest w tym
temacie* and *już masz — w temacie X*; `cardItem` then creates the capture,
enqueues the `new` job and marks the item `carded`. Keeping the item row is
what makes the in-topic duplicate check work, and `linkItem` later fills in its
`cardId` as it does for `+ karta` today.

`POST /api/topics/[id]/cards` is the route.

- **202** `{ item, captureId }` on success.
- **400** `empty`, **404** unknown topic.
- **409** with the Polish message, for both duplicate cases, exactly as the
  items route returns them today.

`POST /api/topics/[id]/items` is retired: the topic page was its only caller,
and nothing creates an open item by hand any more. `addManualItem` stays as the
primitive, with its own tests.

The word appears as pending on `z kartą` and becomes a card when generation
finishes — the same path `+ karta` takes.

## 7. Testing

TDD throughout. The cases worth naming are the ones where remembering is a
hazard rather than a feature:

- **The store:** a value survives unmount and remount; two topic ids do not
  share a slice; `useRestoreScroll` restores only once content exists.
- **`/powtorki`:** a remount mid-session re-uses the queue and issues no fetch,
  with a revealed answer still revealed. This is the behaviour most likely to
  regress into "re-fetch on every return".
- **`/tematy`:** a remount *does* fetch, paints the remembered list first, and
  shows a word recorded on `/dodaj` on return — item 5, end to end.
- **`/dodaj`:** the trigger opens the sheet; `✕` is absent on Ogólne and resets
  from any other topic; the chosen topic reaches `POST /api/captures`; an
  unknown topic id is a 400; `topicId` round-trips through the outbox.
- **The topic page:** `+` expands the bar; the draft survives a remount;
  submitting posts to `/cards`; both 409 texts reach the screen; the bar is
  gone from `bez karty` and has no mic buttons.
- **`addManualCard`:** the item is `carded`, a capture and a `new` job exist,
  and each duplicate case refuses without writing anything.
