'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Mic, Plus, X } from '@/components/ui/icons'
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
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-base"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onPointerDown={pl.start}
          onPointerUp={pl.stop}
          onPointerCancel={pl.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordPolish}
          className={`inline-flex h-9 select-none items-center gap-1 rounded-full px-3 text-white ${pl.recording ? 'bg-red-600' : 'bg-primary'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          <Icon icon={Mic} size={16} />
          PL
        </button>
        <button
          type="button"
          onPointerDown={ru.start}
          onPointerUp={ru.stop}
          onPointerCancel={ru.stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={t.recordRussian}
          className={`inline-flex h-9 select-none items-center gap-1 rounded-full px-3 text-white ${ru.recording ? 'bg-red-600' : 'bg-primary'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          <Icon icon={Mic} size={16} />
          RU
        </button>
        <span className="ml-auto flex gap-2">
          <Button variant="primary" icon={Plus} label={t.addItem} disabled={text.trim() === ''} busy={busy} onClick={() => void add()} />
          <Button variant="icon" icon={X} label={t.cancel} onClick={cancel} />
        </span>
      </div>
      {micDenied && <p className="text-sub text-red-600">{t.micDenied}</p>}
      {message && <p className="text-sub text-red-600">{message}</p>}
    </div>
  )
}
