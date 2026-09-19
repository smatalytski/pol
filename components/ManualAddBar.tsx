'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { mediaRecorderFactory, useHoldToRecord } from '@/hooks/useHoldToRecord'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'

/**
 * Adding an item by hand — typed or dictated (spec 2026-09-19-topic-items
 * §4.6). Unlike app/tematy/nowy's context recorder, a recording here
 * *replaces* the field rather than appending to it: this bar adds one word
 * or phrase at a time, not a running description.
 */
export function ManualAddBar({ onAdd }: { onAdd: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [micDenied, setMicDenied] = useState(false)
  const [busy, setBusy] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)

  // One getUserMedia stream shared by both hold buttons, same as
  // app/dodaj/page.tsx and app/tematy/nowy/page.tsx: only one can be
  // recording at a time, so there is nothing to gain from two streams.
  const getStream = useCallback(async () => {
    try {
      streamRef.current ??= await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setMicDenied(true)
      throw new Error('microphone unavailable')
    }
    return streamRef.current
  }, [])

  const factory = useMemo(() => mediaRecorderFactory(getStream), [getStream])

  const record = useCallback(async (bytes: ArrayBuffer, mime: string, lang: DictationLang) => {
    setMessage(null)
    const form = new FormData()
    form.set('audio', new Blob([bytes], { type: mime }))
    form.set('lang', lang)
    try {
      const res = await fetch('/api/topics/transcribe', { method: 'POST', body: form })
      const body = (await res.json()) as { transcript?: string }
      if (!res.ok || !body.transcript) throw new Error()
      setText(body.transcript)
    } catch {
      setMessage(t.transcribeFailed)
    }
  }, [])

  const onRecordedPl = useCallback((b: ArrayBuffer, m: string) => void record(b, m, 'pl'), [record])
  const onRecordedRu = useCallback((b: ArrayBuffer, m: string) => void record(b, m, 'ru'), [record])
  const pl = useHoldToRecord({ factory, onRecorded: onRecordedPl })
  const ru = useHoldToRecord({ factory, onRecorded: onRecordedRu })

  async function add() {
    const trimmed = text.trim()
    if (!trimmed) return
    setBusy(true)
    const error = await onAdd(trimmed)
    setBusy(false)
    if (error) {
      setMessage(error)
    } else {
      setText('')
      setMessage(null)
    }
  }

  function cancel() {
    setText('')
    setMessage(null)
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <input
        aria-label={t.manualAdd}
        placeholder={t.manualPlaceholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="rounded border p-2"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onPointerDown={pl.start}
          onPointerUp={pl.stop}
          onPointerCancel={pl.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordPolish}
          className={`select-none rounded-full px-3 py-2 text-white ${pl.recording ? 'bg-red-600' : 'bg-black'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          PL
        </button>
        <button
          type="button"
          onPointerDown={ru.start}
          onPointerUp={ru.stop}
          onPointerCancel={ru.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordRussian}
          className={`select-none rounded-full px-3 py-2 text-white ${ru.recording ? 'bg-red-600' : 'bg-black'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          RU
        </button>
        <button
          type="button"
          disabled={busy || text.trim() === ''}
          onClick={() => void add()}
          className="rounded bg-black px-3 py-1 text-white disabled:opacity-40"
        >
          {t.add}
        </button>
        <button type="button" onClick={cancel} className="rounded border px-3 py-1">
          {t.cancel}
        </button>
      </div>
      {micDenied && <p className="text-red-600">{t.micDenied}</p>}
      {message && <p className="text-red-600">{message}</p>}
    </div>
  )
}
