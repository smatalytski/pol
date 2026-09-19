'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { mediaRecorderFactory, useHoldToRecord } from '@/hooks/useHoldToRecord'
import { BatchSettings } from '@/components/BatchSettings'
import { DEFAULT_COUNT, type BatchParams } from '@/lib/topics/rounds'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'

/**
 * A new topic: describe the situation by typing or by holding the mic (spec
 * §4.3). A recording is recognised straight into the text area for
 * correction; it never becomes a capture.
 */
export default function NewTopicPage() {
  const router = useRouter()
  const [context, setContext] = useState('')
  // level is not yet chosen here; a later task adds the control (spec §4.5).
  const [params, setParams] = useState<BatchParams>({ count: DEFAULT_COUNT, mix: 'mieszane', level: 'zaawansowany' })
  const [lang, setLang] = useState<DictationLang>('ru')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [micDenied, setMicDenied] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)

  // Same pattern as app/dodaj/page.tsx's getStream: a refused or unavailable
  // microphone is reported once, distinctly from a transcription failure —
  // but unlike /dodaj this screen still works by typing, so it never replaces
  // the form.
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

  const onRecorded = useCallback(
    async (bytes: ArrayBuffer, mime: string) => {
      setError(null)
      const form = new FormData()
      form.set('audio', new Blob([bytes], { type: mime }))
      form.set('lang', lang)
      try {
        const res = await fetch('/api/topics/transcribe', { method: 'POST', body: form })
        const body = (await res.json()) as { transcript?: string }
        if (!res.ok || !body.transcript) throw new Error()
        setContext((c) => (c.trim() ? `${c.trim()} ${body.transcript}` : body.transcript!))
      } catch {
        setError(t.transcribeFailed)
      }
    },
    [lang],
  )

  const { recording, start, stop } = useHoldToRecord({ factory, onRecorded })

  async function propose() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: context.trim(), ...params }),
      })
      if (!res.ok) throw new Error()
      router.push(`/tematy/${((await res.json()) as { topicId: string }).topicId}`)
    } catch {
      setError(t.topicSaveFailed)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        {t.topicContext}
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder={t.topicContextPlaceholder}
          rows={4}
          className="rounded border p-3"
        />
      </label>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={`select-none rounded-full px-4 py-3 text-white ${recording ? 'bg-red-600' : 'bg-black'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          {t.holdToDictate}
        </button>
        {(['ru', 'pl'] as const).map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={lang === l ? 'underline' : 'text-neutral-500'}
          >
            {l === 'ru' ? t.asRussian : t.asPolish}
          </button>
        ))}
      </div>
      {micDenied && <p className="text-sm text-red-600">{t.micDenied}</p>}
      <BatchSettings value={params} onChange={setParams} />
      <button
        type="button"
        disabled={busy || context.trim() === ''}
        onClick={() => void propose()}
        className="self-start rounded bg-black px-4 py-2 text-white disabled:opacity-40"
      >
        {t.propose}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
