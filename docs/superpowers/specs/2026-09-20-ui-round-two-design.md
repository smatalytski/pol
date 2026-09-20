# Fiszki — accept now, pinned filters, and an explicit listening topic list

Date: 2026-09-20
Status: approved in conversation, awaiting written-spec review

## 1. What changes, in one paragraph

Five screens get a usability pass, on top of the icon round (spec 2026-09-19) and the `--primary` colour token.
- **`/dodaj`:** a recording under review gains a `zatwierdź` button beside its draining bar, so the card is made now instead of ten seconds from now.
- **`/fiszki`:** the search box is pinned to the top of the screen instead of scrolling away.
- **`/tematy`:** `nowy temat` becomes a round `+` button above the tab bar, and a pinned filter box is added at the top.
- **`/ustawienia`:** the four number fields become one-line rows like the switches, and the existing general settings get an `Ogólne` heading to balance `Słuchanie`.
- **`/sluchaj`:** topics are no longer all listed up front. Topics are chosen one at a time through a search sheet and removed individually; none chosen means every topic, as it already does today.
- **Out of scope:** dark mode, which still paints a near-invisible primary on `#0a0a0a` and is a round of its own, and anything the player does once a session has started.

## 2. Decisions

- **Accept now is a real promotion**, not a backdated clock. See §3.1.
- **The listening topic picker is a full-screen sheet with a search box** (chosen over an inline expanding list and a native `<select>`), because the topic list grows without bound and is the one place in the app that needs to be searched rather than scanned.
- **All four number settings become one-line rows**, not only the two delays, so the new `Ogólne` section and the existing `Słuchanie` section share one row shape.
- **The listening topic choice is not remembered** between visits. Session length stays remembered, as today. A stale narrow selection would silently shorten a session with no visible cause.

## 3. `/dodaj` — accept now

### 3.1 Promotion, split from the clock

Approval is currently derived: `lib/queue/review.ts`'s `approvedIds` names the recordings whose ten seconds are up, and `lib/queue/jobs.ts`'s `promoteApproved` does the work of promoting them — duplicate detection, job insert, all in one transaction.

`promoteApproved` is split so that *which* recordings and *promote them* are separate:

```ts
/** Promote exactly these recordings, whatever the clock says. */
export function promoteIds(db: Db, ids: readonly string[]): { queued: string[]; duplicates: string[] }

/** Unchanged signature and behaviour; now `promoteIds(db, approvedIds(underReview(db), now))`. */
export function promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] }
```

`promoteIds` keeps today's ordering (oldest transcript first, ties by `createdAt`), the single transaction, and the existing `status = 'transcribed'` guard — that guard is what makes a double promotion a no-op rather than a second card.

`approvedIds` stays a pure function of the clock. No migration, and `transcribed_at` keeps meaning when the transcript arrived.

### 3.2 `POST /api/captures/[id]/zatwierdz`

- Calls `promoteIds(db, [id])`.
- **404** if no capture has that id.
- **409** if the capture's status is not `transcribed` — it was already promoted, failed, or is still uploading.
- **200** `{ ok: true }` otherwise.

Re-tapping a button whose response has not landed is the realistic race; the status guard makes the second call a 409 with no second card.

### 3.3 The chip

`CaptureChip` gains an `onApprove: (id: string) => void` prop. While `capture.inReview`, a `primary` `zatwierdź` button with the `Check` icon (added to `components/ui/icons.ts`, which is the only door to lucide) sits before `usuń` in the existing control row. It takes the same `pending` disable and the same `own` pointer-stopping handlers as the other controls, so a tap never reads as a delete swipe.

The draining bar stays — it is what tells you there is a deadline to pre-empt.

On success the recording is promoted, so the next poll (already running, since `inReview` keeps `hasPending` true) drops it from `listOnScreen` and the chip leaves the screen. A failed or refused call surfaces through the existing `notice` line, as `deleteChip` already does; a new `approveFailed` notice is added.

## 4. `/fiszki` — pinned filter

The search box is wrapped in:

```
sticky top-0 z-10 -mx-4 px-4 py-2 bg-background
```

`main` in `app/layout.tsx` has `px-4 pt-4` and the page scrolls the document, so `-mx-4 px-4` makes the wrapper full-bleed and the opaque background keeps rows legible as they scroll behind it. Nothing in the shell sets `overflow`, so `sticky` pins against the viewport as intended.

No API change; the pending-row filter and the `q`-driven fetch are untouched.

## 5. `/tematy` — a `+` button at the bottom, a filter at the top

### 5.1 The button

The `nowy temat` link moves to a fixed round button above the tab bar:

```
above-tabbar fixed inset-x-0 z-10   →   inner mx-auto max-w-xl px-4 pb-4 flex justify-end
```

The re-centring wrapper is required because a fixed element ignores the body's `mx-auto max-w-xl`; `/dodaj`'s record bar already does exactly this and its comment explains why `sticky` does not work here.

It stays a `<Link>` to `/tematy/nowy` carrying `aria-label` and `title` of `t.newTopic`, so the accessible name tests already look for survives the word disappearing.

Its classes are written out rather than taken from `buttonClass`: the button is 56 px, and appending `h-14` to `buttonClass`'s `h-10` would leave two height utilities fighting in the stylesheet, where the winner is decided by Tailwind's output order rather than by the order they appear in the attribute.

The list gets bottom padding so the button never covers the last row.

### 5.2 The filter

The same pinned box as §4, filtering the already-loaded list by topic name, case-insensitively. `t.unnamedTopic` rows match an empty query only. No API change.

## 6. `/ustawienia` — one-line rows and an `Ogólne` heading

An `Ogólne` heading (`t.settingsGeneral`) is added above `Nowe fiszki na dzień`, styled exactly like the existing `Słuchanie` heading.

All four number fields change from

```
<label class="flex flex-col gap-1">  label above, w-full input below
```

to a one-line row: label left, a compact right-aligned input (`w-20 text-right`), matching the height and rhythm of the `Switch` rows. The labels are unchanged, so tests that find a field by its label keep working.

**The save logic does not change.** The controlled drafts, the revert-on-rejection, and the per-key `patch` scoping all stay exactly as they are — the comments there record two real review findings (A3 and the cross-field clobber guard) and this round is markup only. Inputs still save on blur; switches still save on change.

## 7. `/sluchaj` — an explicit topic list

### 7.1 What is shown

Today every unsuspended topic is rendered as a chip, plus a `wszystkie` chip. Instead:

- **Nothing selected** (the default on every visit): no chips, and a muted line saying every topic will play (`t.listenTopicsAll`).
- **Something selected:** one chip per chosen topic, each with an `×` that removes it.
- Below either, a `+ temat` button that opens the sheet.

The `wszystkie` chip is removed: an empty selection *is* everything, and offering both a chip and an empty state for one condition invites them to disagree.

`handleStart` is unchanged — it already sends `topicIds` only when the selection is non-empty, so "empty means everything" is existing server behaviour, not new.

Suspended topics stay excluded, as today.

### 7.2 `components/ui/Sheet.tsx`

A new shared overlay, since the app has none:

- `role="dialog"`, `aria-modal="true"`, `aria-label` from a required prop.
- Opens covering the screen; closes on Escape and on the `zamknij` button. It covers the page rather than dimming it, so there is no backdrop to tap.
- Focus moves to the sheet on open and returns to the opener on close; focus is trapped while open.
- Body scroll is locked while open.
- Renders nothing when closed.

### 7.3 The picker

Inside the sheet: a search input focused on open, then the unselected, unsuspended topics filtered by name, case-insensitively. Tapping one adds it and closes the sheet. An empty result shows a muted line; a sheet opened with every topic already chosen says so rather than showing an empty list.

## 8. Strings (`i18n/pl.ts`)

| key | Polish |
|---|---|
| `approveNow` | `zatwierdź` |
| `approveFailed` | `Nie udało się zatwierdzić nagrania.` |
| `settingsGeneral` | `Ogólne` |
| `filterTopics` | `Szukaj tematu` |
| `addTopic` | `+ temat` |
| `removeTopic` | `usuń temat` |
| `listenTopicsAll` | `Bez wyboru grane są wszystkie tematy.` |
| `sheetClose` | `zamknij` |
| `noTopicsFound` | `Brak tematów` |
| `allTopicsChosen` | `Wszystkie tematy już wybrane` |

`listenAllTopics` (`wszystkie`) becomes unused and is removed — including from the `required` list in `i18n/pl.test.ts`, which names every key explicitly.

The chip's `×` uses the already-exported `X`; `Check` is the one new icon.

## 9. Testing

Every screen keeps its existing tests. New:

- **`lib/queue/jobs.test.ts`** — `promoteIds` promotes one recording mid-window; a second call is a no-op; a non-`transcribed` row is untouched; `promoteApproved` still behaves as before.
- **`app/api/captures/[id]/zatwierdz`** — 200 makes the card, 404 unknown id, 409 wrong status.
- **`CaptureChip.dom.test.tsx`** — the button shows only while `inReview`, calls `onApprove`, and is disabled while `pending`.
- **`app/dodaj/page.dom.test.tsx`** — a failed approve shows the notice.
- **`Sheet.dom.test.tsx`** — Escape and backdrop close it, focus is trapped and restored, nothing renders when closed.
- **`app/sluchaj/page.dom.test.tsx`** — no chips by default; adding through the sheet; removing a chip; `start` sends no `topicIds` when the selection is empty and the chosen ids when it is not.
- **`app/tematy/page.dom.test.tsx`** — the filter narrows the list; the `+` link still resolves by its accessible name.
- **`app/fiszki/page.dom.test.tsx`** and **`app/ustawienia/page.dom.test.tsx`** — existing tests must pass unchanged, which is the point: both are markup-only changes.

## 10. Migrations

None.
