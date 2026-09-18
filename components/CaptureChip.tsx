'use client'
import { useRef } from 'react'
import type { CaptureView } from '@/lib/capture/pipeline'
import { REVIEW_MS } from '@/lib/queue/review'
import { t } from '@/i18n/pl'

/**
 * A chip renders one of two things: a recording that has no server row yet
 * (still sitting in the local outbox, possibly stuck retrying an upload), or
 * a capture the server already knows about. These are deliberately kept as
 * one discriminated union rather than two components so the merged list in
 * `app/dodaj/page.tsx` can render both from a single `.map`.
 *
 * `outbox:${id}` / `capture:${id}` keys (assigned by the caller via
 * `chipKey`) come from two disjoint id spaces — the outbox id is generated
 * client-side by `crypto.randomUUID()` in `onRecorded` and is never sent to
 * the server, while the capture id is generated server-side in
 * `createCapture`. An outbox item is deleted from the local store at the
 * same point the matching server row already exists (`outbox.ts`'s `flush`
 * awaits the upload, which only resolves after `createCapture` has run,
 * before it deletes the item), so there is at most one poll cycle where both
 * a `outbox:` chip and the `capture:` chip for the same word are visible at
 * once. That brief overlap is expected and self-corrects on the next poll;
 * nothing here tries to eagerly suppress it, since doing so would require
 * correlating the two unrelated id spaces.
 *
 * The chip itself is status-only (Task 8): no audio player, no type switch,
 * no tap-to-edit form. A recording under review offers only usuń, with a bar
 * draining toward approval — a wrong language is not fixed here (Task 4
 * removed re-recognition); it is deleted and recorded again with the
 * matching PL/RU button on /dodaj. A failed recognition offers ponów
 * instead. There is nothing here for a card the recording turned into — an
 * on-screen recording is by definition still uploaded, failed, or under
 * review (see `listOnScreen`).
 */
export type ChipItem =
  | { kind: 'outbox'; id: string; createdAt: number }
  | { kind: 'capture'; capture: CaptureView }

export function chipKey(item: ChipItem): string {
  return item.kind === 'outbox' ? `outbox:${item.id}` : `capture:${item.capture.id}`
}

export function chipCreatedAt(item: ChipItem): number {
  return item.kind === 'outbox' ? item.createdAt : item.capture.createdAt
}

// Horizontal distance (px) a pointer must travel before a release counts as a
// swipe rather than a tap. Chosen the same way the recording gesture's 300ms
// tap threshold was: large enough that an ordinary tap (a few px of finger
// wobble) never fires it, small enough that a deliberate swipe on a phone
// screen clears it easily.
const SWIPE_THRESHOLD_PX = 60

export function CaptureChip({
  item,
  onRetry,
  onDelete,
  pending = false,
}: {
  item: ChipItem
  onRetry: (id: string) => void
  onDelete: (item: ChipItem) => void
  /** A ponów recognition for this recording is in flight; its retry control is disabled until it lands. */
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
          {/* "rozpoznawanie…" is only for a recording still waiting on its
              first transcript (§7.1) — a failed one shows only its error
              below, never this placeholder beside it. */}
          <p className="text-lg">{capture.transcript ?? (capture.status === 'uploaded' ? t.transcribing : null)}</p>
          {capture.duplicateOf && <p className="text-sm text-amber-600">{t.alreadyHave}</p>}
          {capture.error && <p className="text-sm text-red-600">{capture.error}</p>}
        </div>
        {capture.status === 'failed' && (
          <button onClick={() => onRetry(capture.id)} {...own} disabled={pending} className="text-sm underline disabled:text-neutral-400">
            {t.retry}
          </button>
        )}
      </div>

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
