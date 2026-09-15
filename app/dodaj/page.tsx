'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureChip } from '@/components/CaptureChip'
import { useHoldToRecord, mediaRecorderFactory } from '@/hooks/useHoldToRecord'
import { useWakeLock } from '@/hooks/useWakeLock'
import { enqueue, flush } from '@/lib/capture/outbox'
import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

export default function AddPage() {
  const [captures, setCaptures] = useState<CaptureView[]>([])
  const [pendingUploads, setPendingUploads] = useState(0)
  const [micDenied, setMicDenied] = useState(false)
  const since = useRef(Date.now() - 60_000)
  const streamRef = useRef<MediaStream | null>(null)

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

  const drain = useCallback(async () => {
    const { kept } = await flush(async (item) => {
      const form = new FormData()
      form.set('audio', new Blob([item.bytes], { type: item.mime }), 'capture.webm')
      const res = await fetch('/api/captures', { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    })
    setPendingUploads(kept.length)
  }, [])

  const onRecorded = useCallback(
    async (bytes: ArrayBuffer, mime: string) => {
      await enqueue({ id: crypto.randomUUID(), bytes, mime, createdAt: Date.now() })
      setPendingUploads((n) => n + 1)
      navigator.vibrate?.(20)
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
  // recording (via `pendingUploads`) restarts it.
  const hasPending =
    pendingUploads > 0 || captures.some((c) => c.status !== 'generated' && c.status !== 'failed')

  useEffect(() => {
    let cancelled = false
    function poll() {
      void fetch(`/api/captures?since=${since.current}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setCaptures(d.captures)
        })
      void drain()
    }
    // Always poll once on mount (or whenever pending work appears) so a
    // capture left mid-pipeline from a previous session is picked up even
    // though nothing here has recorded anything new yet.
    poll()
    const id = hasPending ? setInterval(poll, 1000) : null
    return () => {
      cancelled = true
      if (id) clearInterval(id)
    }
  }, [hasPending, drain])

  const retry = useCallback((id: string) => {
    void fetch(`/api/captures/${id}/retry`, { method: 'POST' })
  }, [])

  // Without a microphone this screen has no function at all, so say so plainly
  // rather than presenting a button that silently does nothing.
  if (micDenied) {
    return <p className="p-6 text-lg">{t.micDenied}</p>
  }

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
      {pendingUploads > 0 && <p className="text-sm text-neutral-500">{pendingUploads}</p>}

      <ul className="w-full">
        {captures.map((c) => (
          <CaptureChip key={c.id} capture={c} onRetry={retry} />
        ))}
      </ul>
    </div>
  )
}
