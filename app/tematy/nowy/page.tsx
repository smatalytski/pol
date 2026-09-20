'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { mediaRecorderFactory, useHoldToRecord } from '@/hooks/useHoldToRecord'
import { BatchSettings } from '@/components/BatchSettings'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Mic, Sparkles } from '@/components/ui/icons'
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
  // `zaawansowany` is the starting level; BatchSettings' level toggle
  // changes it (spec §4.5), and the choice rides along in the POST body.
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
      <label className="flex flex-col gap-1 text-sub text-neutral-500">
        {t.topicContext}
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder={t.topicContextPlaceholder}
          rows={4}
          className="w-full rounded-lg border border-neutral-300 p-3 text-base text-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={`inline-flex select-none items-center gap-2 rounded-full px-4 py-3 text-white ${recording ? 'bg-red-600' : 'bg-primary'}`}
          style={{ touchAction: 'none', WebkitUserSelect: 'none' }}
        >
          <Icon icon={Mic} />
          {t.holdToDictate}
        </button>
        <div className="flex rounded-lg border border-neutral-300 p-0.5 text-sm">
          {(['ru', 'pl'] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={lang === l}
              onClick={() => setLang(l)}
              className={`min-h-8 rounded-md px-2 py-1 ${lang === l ? 'bg-primary text-white' : 'text-neutral-600'}`}
            >
              {l === 'ru' ? t.asRussian : t.asPolish}
            </button>
          ))}
        </div>
      </div>
      {micDenied && <p className="text-sub text-red-600">{t.micDenied}</p>}
      <BatchSettings value={params} onChange={setParams} />
      <Button
        variant="primary"
        size="md"
        icon={Sparkles}
        label={t.propose}
        disabled={context.trim() === ''}
        busy={busy}
        onClick={() => void propose()}
        className="self-start"
      />
      {error && <p className="text-sub text-red-600">{error}</p>}
    </div>
  )
}
