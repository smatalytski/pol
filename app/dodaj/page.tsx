'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureChip, chipCreatedAt, chipKey, type ChipItem } from '@/components/CaptureChip'
import { useHoldToRecord, mediaRecorderFactory } from '@/hooks/useHoldToRecord'
import { useWakeLock } from '@/hooks/useWakeLock'
import { enqueue, flush, listOutbox, type OutboxItem } from '@/lib/capture/outbox'
import type { CaptureView } from '@/lib/capture/pipeline'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'
import { Icon } from '@/components/ui/Icon'
import { Mic } from '@/components/ui/icons'

type Notice = 'deleteFailed' | 'approveFailed'

const NOTICE_TEXT: Record<Notice, string> = {
  deleteFailed: t.deleteFailed,
  approveFailed: t.approveFailed,
}

export default function AddPage() {
  const [captures, setCaptures] = useState<CaptureView[]>([])
  const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([])
  const [micDenied, setMicDenied] = useState(false)
  // One notice line for the chip controls' outcomes. A failed or refused
  // request would otherwise look exactly like a dead button.
  const [notice, setNotice] = useState<Notice | null>(null)
  // Captures whose recognition (ponów) is in flight. Every recording on this
  // screen has no card yet (§7.1: uploaded, failed, or still under review),
  // so ponów is Speech-to-Text only, but it is still a network round trip, so
  // without this the user taps again and starts a second one on the same
  // recording.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const since = useRef(Date.now() - 60_000)
  const streamRef = useRef<MediaStream | null>(null)

  // Shared by every async chain below (drain, poll, the chip actions) that
  // eventually calls a setter: guards against updating state after the screen
  // has been navigated away from, rather than each chain inventing its own
  // flag.
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // One getUserMedia for the whole session, so the second and later presses
  // start recording instantly instead of waiting on a permission round-trip.
  const getStream = useCallback(async () => {
    try {
      streamRef.current ??= await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setMicDenied(true)
      throw new Error('microphone unavailable')
    }
    return streamRef.current
  }, [])

  // Split from `fetchCaptures` below so `drain` can pull the raw data without
  // committing it to state on its own — see the `sent.length > 0` branch.
  const fetchCapturesData = useCallback(async (): Promise<CaptureView[]> => {
    const res = await fetch(`/api/captures?since=${since.current}`)
    const d = await res.json()
    return d.captures as CaptureView[]
  }, [])

  const fetchCaptures = useCallback(async () => {
    const captures = await fetchCapturesData()
    if (mountedRef.current) setCaptures(captures)
  }, [fetchCapturesData])

  const drain = useCallback(async () => {
    const { sent } = await flush(async (item) => {
      const form = new FormData()
      form.set('audio', new Blob([item.bytes], { type: item.mime }), 'capture.webm')
      // An older entry saved before the language existed has no `lang`, so no
      // field is sent and the server stores it as Polish.
      if (item.lang) form.set('lang', item.lang)
      const res = await fetch('/api/captures', { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    })
    if (sent.length > 0) {
      // A sent item's server row already exists by the time `flush` deleted
      // it (the upload only resolves after `createCapture` ran). Fetch that
      // row *before* clearing the local outbox chip, and commit both state
      // updates together, so the word is never absent from every list at
      // once — worst case it briefly appears in both (the outbox chip and
      // the new capture chip), which is harmless and self-corrects on the
      // next render, unlike a gap where it's in neither.
      const [captures, items] = await Promise.all([fetchCapturesData(), listOutbox()])
      if (mountedRef.current) {
        setCaptures(captures)
        setOutboxItems(items)
      }
    } else {
      // Nothing landed (upload still failing/retrying) — still refresh
      // outboxItems so the attempt count and retry state stay visible.
      const items = await listOutbox()
      if (mountedRef.current) setOutboxItems(items)
    }
  }, [fetchCapturesData])

  const onRecorded = useCallback(
    async (bytes: ArrayBuffer, mime: string, lang: DictationLang) => {
      await enqueue({ id: crypto.randomUUID(), bytes, mime, createdAt: Date.now(), lang })
      navigator.vibrate?.(20)
      // Reflect the just-enqueued recording immediately, as its own chip,
      // rather than waiting for `drain` to attempt (and possibly finish) the
      // upload first — otherwise a fast upload could skip the "uploading"
      // state entirely and a slow one would leave the word unaccounted for
      // until the next poll tick.
      const items = await listOutbox()
      if (mountedRef.current) setOutboxItems(items)
      await drain()
    },
    [drain],
  )

  // One factory (one getUserMedia stream) shared by both buttons, since only
  // one can ever be recording at a time — the language is only which button
  // the hold started on, not a property of the recorder itself.
  const factory = useMemo(() => mediaRecorderFactory(getStream), [getStream])
  const onRecordedPl = useCallback((b: ArrayBuffer, m: string) => void onRecorded(b, m, 'pl'), [onRecorded])
  const onRecordedRu = useCallback((b: ArrayBuffer, m: string) => void onRecorded(b, m, 'ru'), [onRecorded])
  const pl = useHoldToRecord({ factory, onRecorded: onRecordedPl })
  const ru = useHoldToRecord({ factory, onRecorded: onRecordedRu })

  useWakeLock(true)

  // Spec §9: poll, don't stream — and only while something is actually
  // in flight. Polling runs while anything is uploading, recognising or under
  // review, since a recording under review leaves the screen only when the
  // server stops returning it. Polling forever on a phone-first app is a
  // battery drain for no benefit once the screen is idle, so the interval is
  // torn down the moment nothing is left to watch, and a fresh recording (via
  // `outboxItems`) restarts it.
  const hasPending =
    outboxItems.length > 0 || captures.some((c) => c.status === 'uploaded' || c.inReview)

  useEffect(() => {
    function poll() {
      // A failed poll (offline) is retried on the next tick; it must not
      // surface as an unhandled rejection.
      void fetchCaptures().catch(() => {})
      void drain().catch(() => {})
    }
    // Always poll once on mount (or whenever pending work appears) so a
    // capture left mid-pipeline from a previous session is picked up even
    // though nothing here has recorded anything new yet.
    poll()
    const id = hasPending ? setInterval(poll, 1000) : null
    return () => {
      if (id) clearInterval(id)
    }
  }, [hasPending, drain, fetchCaptures])

  // A failed refresh after a chip action is not reported: the action's own
  // outcome already was, and the chip is only as stale as it was before.
  const refresh = useCallback(() => fetchCaptures().catch(() => {}), [fetchCaptures])

  // Runs one slow chip action with the chip marked pending until the list has
  // been refreshed, so its controls come back only once they show the result.
  const whilePending = useCallback(
    async (captureId: string, action: () => Promise<void>) => {
      setPending((p) => new Set(p).add(captureId))
      await action()
      await refresh()
      if (mountedRef.current) {
        setPending((p) => {
          const next = new Set(p)
          next.delete(captureId)
          return next
        })
      }
    },
    [refresh],
  )

  // ponów re-runs recognition of a failed recording. A failed recording does
  // not keep the polling alive, so without the refresh whilePending does
  // afterwards the new transcript would never reach the screen and the
  // recording would be approved unseen. A request that fails or is refused
  // leaves the recording failed, which the refreshed chip still shows.
  const retry = useCallback(
    (id: string) => {
      void whilePending(id, async () => {
        await fetch(`/api/captures/${id}/retry`, { method: 'POST' }).catch(() => {})
      })
    },
    [whilePending],
  )

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

  // Spec §4's "swipe to delete", and the visible `usuń` button (swipe alone
  // was invisible) calls the same handler. An outbox chip never calls this
  // (CaptureChip doesn't attach either control to it — see its own comment),
  // so this only ever sees a `capture` item. An on-screen recording never has
  // a card (it is uploaded, failed or under review — see `listOnScreen`), so
  // rejecting it always deletes the recording itself, never a card. A refused
  // or unreachable delete leaves the chip on screen, so the notice says the
  // delete did not happen.
  const deleteChip = useCallback(
    (item: ChipItem) => {
      if (item.kind === 'outbox') return
      const { capture } = item
      const url = `/api/captures/${capture.id}`
      void (async () => {
        try {
          const res = await fetch(url, { method: 'DELETE' })
          if (mountedRef.current) setNotice(res.ok ? null : 'deleteFailed')
        } catch {
          if (mountedRef.current) setNotice('deleteFailed')
        }
        await refresh()
      })()
    },
    [refresh],
  )

  // Without a microphone this screen has no function at all, so say so plainly
  // rather than presenting a button that silently does nothing.
  if (micDenied) {
    return <p className="p-6 text-lg">{t.micDenied}</p>
  }

  // Outbox items (no server row yet — still local, possibly stuck retrying an
  // upload) and server-known captures are merged into one waterfall, newest
  // first. See `components/CaptureChip.tsx` for how the two id spaces are
  // kept from permanently colliding.
  const chips: ChipItem[] = [
    ...outboxItems.map((o): ChipItem => ({ kind: 'outbox', id: o.id, createdAt: o.createdAt })),
    ...captures.map((c): ChipItem => ({ kind: 'capture', capture: c })),
  ].sort((a, b) => chipCreatedAt(b) - chipCreatedAt(a))

  return (
    <div className="flex flex-col">
      {notice && <p className="p-3 text-sm text-red-600">{NOTICE_TEXT[notice]}</p>}
      {/* Bottom padding reserves the height of the fixed bar below, so the
          last chip can still be read and swiped instead of sitting under the
          button. */}
      <ul className="w-full pb-60">
        {chips.map((item) => (
          <CaptureChip
            key={chipKey(item)}
            item={item}
            onRetry={retry}
            onDelete={deleteChip}
            onApprove={approve}
            pending={item.kind === 'capture' && pending.has(item.capture.id)}
          />
        ))}
      </ul>

      {/* One-handed use: a thumb reaches the bottom of a phone screen, not the
          top, and this list grows downward — so a button above it drifts
          further out of reach the longer a session runs.

          Fixed, not sticky. `sticky bottom-0` shipped first and did not work:
          sticky only pins an element once its container overflows the
          viewport, and nothing in the shell constrains height, so with a few
          chips the page was shorter than the screen and the button sat right
          under them — near the top, exactly where it started. Fixed anchors it
          to the viewport whatever the list is doing; `left-0 right-0` plus the
          inner max-w-xl re-centres it, because a fixed element ignores the
          shell's `mx-auto max-w-xl`. `px-4` keeps the buttons off the screen
          edges on a narrow phone. `above-tabbar` stacks it directly on top of
          the bottom tab bar (components/TabBar.tsx), which owns the
          safe-area inset, and the opaque background stops chips showing
          through as they scroll underneath.

          Two buttons, not one with a language toggle: the choice has to be
          made before the hold, since a hold is Polish or Russian, never both
          — a modal or a separate toggle tap would slow down the exact moment
          a two-handed toggle-then-hold gesture is trying to avoid. Both
          buttons share one getStream/factory (`pl`/`ru` below) since only one
          can ever be recording at a time. This is a single flex container,
          not a caption plus a nested row for the buttons: `flex-wrap` plus
          the caption's `w-full` puts the caption on its own row above the
          two buttons with no wrapper div needed. `gap-x-6` separates the two
          buttons; `gap-y-2` is the (smaller) gap between the caption's row
          and the buttons' row, so the bar stays short enough for the list's
          bottom padding above to cover it. */}
      <div className="above-tabbar fixed left-0 right-0 z-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-neutral-200 bg-background px-4 py-4">
        <p className="w-full text-center text-sm text-neutral-500">{t.holdToRecord}</p>
        <button
          onPointerDown={() => { navigator.vibrate?.(10); pl.start() }}
          onPointerUp={pl.stop}
          onPointerCancel={pl.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordPolish}
          className={`h-36 w-36 select-none rounded-full text-white ${pl.recording ? 'bg-red-600' : 'bg-primary'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          <span className="flex flex-col items-center gap-1">
            <Icon icon={Mic} size={32} />
            <span className="text-lg font-semibold">PL</span>
          </span>
        </button>
        <button
          onPointerDown={() => { navigator.vibrate?.(10); ru.start() }}
          onPointerUp={ru.stop}
          onPointerCancel={ru.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordRussian}
          className={`h-36 w-36 select-none rounded-full text-white ${ru.recording ? 'bg-red-600' : 'bg-primary'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          <span className="flex flex-col items-center gap-1">
            <Icon icon={Mic} size={32} />
            <span className="text-lg font-semibold">RU</span>
          </span>
        </button>
      </div>
    </div>
  )
}
