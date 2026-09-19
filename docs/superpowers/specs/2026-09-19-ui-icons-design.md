# Fiszki — icons, a bottom tab bar and a consistent look

Date: 2026-09-19
Status: approved in conversation, awaiting written-spec review
Mockups (the options chosen: navigation C, action buttons C):
https://claude.ai/artifact/NSABFfjsaJnij3p9wwjTZF

## 1. What changes, in one paragraph

Every screen gets the same visual language.
- **Navigation:** a bottom tab bar with an icon and a short label per section, where the thumb is. It replaces the wrapping text links at the top.
- **Actions:** one shared `Button` with four variants. The main action on a row or screen keeps its word next to an icon (`+ karta`, **Start**). Secondary actions such as discard and move become compact icon buttons.
- **Icons:** all from `lucide-react`.
- **Type and layout:** one font (Source Sans 3), one type scale, and one row pattern.
- **Out of scope for this round:** colours stay as they are (black, grey, red); proper dark mode and a palette are a later step. Behaviour, routes, texts and data are unchanged.

## 2. Decisions

- **Navigation:** option C from the mockups, a fixed bottom tab bar with six icon + label columns.
- **Action buttons:** option C from the mockups. The main action is labelled; the other actions are icon-only, with an accessible name.
- **Primary colour:** filled buttons stay **black**. There is no accent colour in this round.
- **Icon source:** `lucide-react`, re-exported through one module.

## 3. Components

### 3.1 `components/ui/Icon.tsx` and `components/ui/icons.ts`

- `icons.ts` re-exports exactly the lucide icons the app uses (§4). Screens import icons only from there.
- `Icon` renders a lucide icon at 20 px (18 px inside `sm` buttons), stroke 2, `currentColor`, `aria-hidden="true"`.

### 3.2 `components/ui/Button.tsx`

A real `<button>`: `type`, `onClick` and `disabled` pass through.

| variant | look | accessible name |
|---|---|---|
| `primary` | filled black, white text, icon + `label` | the visible label |
| `secondary` | outlined, icon + `label` | the visible label |
| `icon` | outlined square, icon only | `aria-label={label}` and `title={label}` |
| `danger` | as `icon` or `secondary` (`iconOnly` prop), red icon and text | as above |

- **Sizes:** `sm` (32 px tall, rows) and `md` (40 px, screen-level). Every tap target is at least 32 × 32 px.
- **`busy`:** disables the button and swaps the icon for a small spinner (`Loader2`, spinning; static under `prefers-reduced-motion`).
- **`label`** is required. It keeps today's Polish action names (`odrzuć`, `temat`, `przywróć` …), so screen readers and tests that find buttons by name keep working.

### 3.3 `components/ui/Switch.tsx`

- An on/off toggle with `role="switch"` and `aria-checked`, operable by keyboard (Space and Enter) and labelled.
- It replaces the `włączony / wyłączony` word button on topics and the checkboxes in Ustawienia.

### 3.4 `components/TabBar.tsx` (replaces `components/Nav.tsx`)

- **Placement:** fixed to the bottom, centred at the app's `max-w-xl` width, with an opaque background.
- **Padding:** `padding-bottom: env(safe-area-inset-bottom)`.
- **Columns:** six equal ones, each an icon over a small label.
- **Current section:** marked with `aria-current="page"`, bold, and a soft pill behind the icon. The current section is the route's first path segment.
- **Rest of the layout:**
  - `app/layout.tsx` renders the tab bar and gives `<main>` enough bottom padding to clear it.
  - `/dodaj`'s fixed record bar moves up to sit just above the tab bar.
  - Its list reserves room for both bars.

## 4. Icon map

**Tab bar:**

| tab | icon |
|---|---|
| Powtórki | `RotateCcw` |
| Słuchaj | `Headphones` |
| Dodaj | `Mic` |
| Fiszki | `Layers` |
| Tematy | `List` |
| Ustawienia (tab label `Ustaw.`) | `Settings` |

**Screens:**

| screen | action | variant · icon |
|---|---|---|
| Powtórki | pokaż | primary · `Eye` |
| | the four ratings | text buttons, no icons, in a 4-wide row |
| | cofnij | icon · `Undo2` |
| Dodaj | PL / RU record | the existing large round buttons + `Mic` |
| | ponów | secondary · `RefreshCw` |
| | usuń | danger icon · `Trash2` |
| Fiszki list | search | `Search` inside the field |
| Card page | wygeneruj ponownie | secondary · `Sparkles` |
| | zawieś / przywróć | secondary · `PauseCircle` / `PlayCircle` |
| | przenieś do odrzuconych | danger secondary · `Archive` |
| | temat: … | secondary · `FolderInput`, keeps `temat: <name>` |
| Tematy | nowy temat | primary · `Plus` |
| | on/off | `Switch` |
| Topic page | + karta | primary · `Plus` |
| | odrzuć | danger icon · `X` |
| | temat (move picker trigger) | icon · `FolderInput` |
| | przywróć | secondary · `Undo2` |
| | jeszcze | primary · `Sparkles` |
| | spróbuj ponownie | secondary · `RefreshCw` |
| | hand-add dodaj / anuluj | primary · `Plus` / icon · `X` |
| | hand-add PL / RU | small round buttons + `Mic` |
| | the three tabs | rounded segments; the selected one filled black |
| Nowy temat | zaproponuj | primary · `Sparkles` |
| | mic | round + `Mic` |
| Słuchaj | Start | primary md · `Play` |
| | pause / play | icon md · `Pause` / `Play` |
| | skip | icon md · `SkipForward` |
| | Stop | secondary · `Square` |
| | Jeszcze raz | primary · `RotateCcw` |
| Ustawienia | checkboxes | `Switch` |

`MoveToTopic`'s trigger becomes a `Button`. On the card page it is `secondary` and keeps the topic name; in rows it is `icon`. Its panel behaviour (spanning the row) is unchanged.

## 5. Type and layout

- **Font:** Source Sans 3 via `next/font/google` (self-hosted at build, with Latin, Latin Extended and Cyrillic subsets), set as the body font. The unused Geist variables are removed from `globals.css`.
- **Type scale:**
  - screen title 20 px bold;
  - row title 17 px;
  - secondary text 15 px, `text-neutral-500`;
  - badges and labels 12 px.
  - `tabular-nums` for counts, `n / N` and minutes.
- **Rows** (topic page, card lists, recording chips):
  - `py-3` with a divider;
  - title on line 1; actions on line 2, right-aligned, `gap-2`;
  - badges as small rounded pills.
- **Screens:** `gap-4` between blocks.
- **Forms:** labels above their fields; full-width fields with `rounded-lg` borders.
- **Kept:** the existing `max-w-xl` column, the two-line rows, and the move panel spanning its row.

## 6. Verification

- **Unit tests:**
  - `Button`: each variant; an icon-only button's accessible name comes from `label`; `busy` disables it and shows the spinner.
  - `Switch`: role, `aria-checked`, and keyboard toggling.
  - `TabBar`: six links in order with their labels; `aria-current` on the current section; safe-area padding.
  - `icons.ts`: every icon named in §4 is exported.
- **Existing screen tests:** they keep finding controls by name. Tests that pinned the old markup (underline classes, `✕` text, `Nav`'s links, the `/dodaj` bar positions, checkbox roles now switches) are updated, and each change is listed in the task report.
- **Build:** `next build` passes, and the first-load JS per route stays within about 10 KB of today.
- **Deploy:** backup, then the fresh-tree swap. There is no migration.
- **On the phone:**
  - the tab bar clears the gesture bar;
  - `/dodaj`'s record buttons sit above the tab bar;
  - nothing hides behind it at the end of long lists;
  - icons read clearly;
  - listening still works with the screen off.

## 7. Out of scope

- A colour palette and semantic tokens.
- Dark mode.
- Animations beyond the spinner.
- Icons on the four review ratings.
