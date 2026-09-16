'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureChip, chipCreatedAt, chipKey, type ChipItem } from '@/components/CaptureChip'
import { useHoldToRecord, mediaRecorderFactory } from '@/hooks/useHoldToRecord'
import { useWakeLock } from '@/hooks/useWakeLock'
import { enqueue, flush, listOutbox, type OutboxItem } from '@/lib/capture/outbox'
import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

export default function AddPage() {
  const [captures, setCaptures] = useState<CaptureView[]>([])
  const [outboxItems, setOutboxItems] = useState<OutboxItem[]>([])
  const [micDenied, setMicDenied] = useState(false)
  const since = useRef(Date.now() - 60_000)
  const streamRef = useRef<MediaStream | null>(null)

  // Shared by every async chain below (drain, poll) that eventually calls a
  // setter: guards against updating state after the screen has been
  // navigated away from, rather than each chain inventing its own flag.
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
  // in flight. A capture is "pending" once uploaded and until the pipeline
  // marks it generated or failed; the outbox counts as pending too, since a
  // stalled upload still needs retrying. Polling forever on a phone-first
  // app is a battery drain for no benefit once the screen is idle, so the
  // interval is torn down the moment nothing is left to watch, and a fresh
  // recording (via `outboxItems`) restarts it.
  const hasPending =
    outboxItems.length > 0 || captures.some((c) => c.status !== 'generated' && c.status !== 'failed')

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

  // Spec §4's "swipe to delete", wired once Task 17 added the routes it
  // needs. An outbox chip never calls this (CaptureChip doesn't attach the
  // gesture to it — see its own comment), so this only ever sees a `capture`
  // item: one with a card is soft-deleted (DELETE /api/cards/:id), one
  // without a card yet (still uploaded/transcribed/failed) has its capture
  // row removed instead (DELETE /api/captures/:id) — there is no card to
  // delete.
  const deleteChip = useCallback(
    (item: ChipItem) => {
      if (item.kind === 'outbox') return
      const { capture } = item
      const url = capture.cardId ? `/api/cards/${capture.cardId}` : `/api/captures/${capture.id}`
      void fetch(url, { method: 'DELETE' }).then(() => fetchCaptures())
    },
    [fetchCaptures],
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
    <div className="flex flex-col items-center gap-6">
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

      <ul className="w-full">
        {chips.map((item) => (
          <CaptureChip key={chipKey(item)} item={item} onRetry={retry} onDelete={deleteChip} />
        ))}
      </ul>
    </div>
  )
}
