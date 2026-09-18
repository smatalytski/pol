'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureChip, chipCreatedAt, chipKey, type ChipItem } from '@/components/CaptureChip'
import { useHoldToRecord, mediaRecorderFactory } from '@/hooks/useHoldToRecord'
import { useWakeLock } from '@/hooks/useWakeLock'
import { enqueue, flush, listOutbox, type OutboxItem } from '@/lib/capture/outbox'
import type { CaptureView } from '@/lib/capture/pipeline'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'

type Notice = 'languageFailed' | 'deleteFailed'

const NOTICE_TEXT: Record<Notice, string> = {
  languageFailed: t.languageFailed,
  deleteFailed: t.deleteFailed,
}

export default function AddPage() {
  const [captures, setCaptures] = useState<CaptureView[]>([])
  const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([])
  const [micDenied, setMicDenied] = useState(false)
  // One notice line for the chip controls' outcomes. A failed or refused
  // request would otherwise look exactly like a dead button.
  const [notice, setNotice] = useState<Notice | null>(null)
  // Captures whose re-recognition is in flight. Every recording on this
  // screen has no card yet (§7.1: uploaded, failed, or still under review),
  // so re-recognition here is Speech-to-Text only — it just restarts the
  // review window — but it is still a network round trip, so without this
  // the user taps again and starts a second one on the same recording.
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
    async (bytes: ArrayBuffer, mime: string) => {
      await enqueue({ id: crypto.randomUUID(), bytes, mime, createdAt: Date.now() })
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

  const { recording, start, stop } = useHoldToRecord({
    factory: mediaRecorderFactory(getStream),
    onRecorded,
  })

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
      void fetchCaptures()
      void drain()
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

  const retry = useCallback((id: string) => {
    void fetch(`/api/captures/${id}/retry`, { method: 'POST' })
  }, [])

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

  // Recognition is Polish by default, because that is what nearly all
  // dictation is and because a two-language recognizer demonstrably swallows
  // Russian (spoken "склеп" came back "sklep"). This re-runs recognition on
  // the stored audio in the language the user names, then refreshes so the
  // corrected transcript appears on the chip without a reload. A provider
  // failure comes back as a 200 with the error recorded on the capture, which
  // the refreshed chip shows; a refused or unreachable request gets the
  // notice instead.
  const relanguage = useCallback(
    (id: string, lang: DictationLang) => {
      void whilePending(id, async () => {
        try {
          const res = await fetch(`/api/captures/${id}/jezyk`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lang }),
          })
          if (mountedRef.current) setNotice(res.ok ? null : 'languageFailed')
        } catch {
          if (mountedRef.current) setNotice('languageFailed')
        }
      })
    },
    [whilePending],
  )

  // Spec §4's "swipe to delete", wired once Task 17 added the routes it
  // needs, and the visible `usuń` button (Task 9: swipe alone was invisible)
  // calls the same handler. An outbox chip never calls this (CaptureChip
  // doesn't attach either control to it — see its own comment), so this only
  // ever sees a `capture` item. An on-screen recording never has a card (it
  // is uploaded, failed or under review — see `listOnScreen`), so rejecting
  // it always deletes the recording itself, never a card. A refused or
  // unreachable delete leaves the chip on screen, so the notice says the
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
      <ul className="w-full pb-52">
        {chips.map((item) => (
          <CaptureChip
            key={chipKey(item)}
            item={item}
            onRetry={retry}
            onDelete={deleteChip}
            onRelanguage={relanguage}
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
          shell's `mx-auto max-w-xl`. The inset padding keeps it clear of the
          home indicator / gesture bar, and the opaque background stops chips
          showing through as they scroll underneath. Nav is at the top of the
          shell (components/Nav.tsx), so nothing collides down here. */}
      <div
        className="fixed bottom-0 left-0 right-0 flex justify-center bg-background pt-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <button
          onPointerDown={() => { navigator.vibrate?.(10); start() }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={`h-40 w-40 select-none rounded-full text-white ${recording ? 'bg-red-600' : 'bg-black'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          {t.holdToRecord}
        </button>
      </div>
    </div>
  )
}
