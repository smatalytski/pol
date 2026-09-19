'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { CardListItem } from '@/components/CardListItem'
import { BatchSettings } from '@/components/BatchSettings'
import { DEFAULT_COUNT, type BatchParams } from '@/lib/topics/rounds'
import type { CardRow } from '@/lib/cards/service'
import type { TopicRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/**
 * The round-era topic view this page was written against. GET /api/topics/:id
 * now returns the grouped view of spec 2026-09-19-topic-items (TopicView in
 * lib/topics/service.ts); this page still reads the old shape until it is
 * rewritten for the three groups.
 */
type TopicView = {
  topic: TopicRow
  state: 'searching' | 'failed' | 'ready' | 'idle'
  error: string | null
  round: number
  items: { id: string; answerPl: string; glossRu: string; kind: 'slowo' | 'fraza' }[]
  cards: CardRow[]
  pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
}

/**
 * One topic (spec 2026-09-18-topic-generation §4.4): its current round, the
 * controls for the next, and its cards. Struck-out items live only here until
 * an accept button sends them; leaving the page accepts nothing.
 */
export default function TopicPage() {
  const { id } = useParams<{ id: string }>()
  const [view, setView] = useState<TopicView | null>(null)
  const [missing, setMissing] = useState(false)
  const [struck, setStruck] = useState<ReadonlySet<string>>(() => new Set())
  // level is not yet chosen here; a later task adds the control (spec §4.5).
  const [params, setParams] = useState<BatchParams>({ count: DEFAULT_COUNT, mix: 'mieszane', level: 'zaawansowany' })
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [loadError, setLoadError] = useState(false)

  // Only a 404 means "not found". Any other non-2xx, malformed body or
  // network error keeps the last view on screen and shows an error line;
  // neither this nor the polling interval may throw out to an unhandled
  // rejection, so every failure is caught here.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/topics/${id}`)
      if (!res.ok) {
        if (res.status === 404) setMissing(true)
        else setLoadError(true)
        return
      }
      const body = (await res.json()) as TopicView
      if (!body || typeof body !== 'object' || !body.topic) throw new Error('malformed topic view')
      setView(body)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // A new round replaces the list; strikes belonged to the old one.
  const round = view?.round
  useEffect(() => {
    setStruck(new Set())
  }, [round])

  const waiting = view !== null && (view.state === 'searching' || view.pending.length > 0)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void load(), 2_000)
    return () => clearInterval(timer)
  }, [waiting, load])

  async function post(url: string, body?: unknown) {
    setBusy(true)
    setSaveError(false)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
    } catch {
      setSaveError(true)
    }
    await load()
    setBusy(false)
  }

  async function patch(fields: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/topics/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error()
    } catch {
      setSaveError(true)
    }
    await load()
  }

  function accept(more: boolean) {
    const body = more ? { rejected: [...struck], next: params } : { rejected: [...struck] }
    void post(`/api/topics/${id}/rounds/${view!.round}`, body)
  }

  function toggle(itemId: string) {
    setStruck((s) => {
      const next = new Set(s)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  if (missing) return <p>{t.topicNotFound}</p>
  if (!view) return loadError ? <p className="text-sm text-red-600">{t.topicsLoadFailed}</p> : null
  const { topic } = view

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy" className="text-sm underline">{t.backToTopics}</Link>

      <div className="flex items-center justify-between gap-3">
        <input
          key={topic.name ?? ''}
          defaultValue={topic.name ?? ''}
          placeholder={t.unnamedTopic}
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (name && name !== topic.name) void patch({ name })
          }}
          className="min-w-0 flex-1 text-xl"
        />
        <button
          type="button"
          onClick={() => void patch({ suspendedAt: topic.suspendedAt === null ? Date.now() : null })}
          className="shrink-0 rounded border px-2 py-1 text-xs"
        >
          {topic.suspendedAt === null ? t.topicOn : t.topicOffToggle}
        </button>
      </div>

      <details>
        <summary className="text-sm text-neutral-500">{t.topicContext}</summary>
        <textarea
          key={topic.context}
          defaultValue={topic.context}
          rows={3}
          onBlur={(e) => {
            const context = e.target.value.trim()
            if (context && context !== topic.context) void patch({ context })
          }}
          className="mt-2 w-full rounded border p-2"
        />
      </details>

      {loadError && <p className="text-sm text-red-600">{t.topicsLoadFailed}</p>}

      {view.state === 'searching' && <p className="text-neutral-500">{t.searching}</p>}

      {view.state === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">{view.error}</p>
          <button type="button" disabled={busy} onClick={() => void post(`/api/topics/${id}/retry`)} className="self-start underline">
            {t.tryAgain}
          </button>
        </div>
      )}

      {view.state === 'ready' && (
        <ul>
          {view.items.map((item) => {
            const off = struck.has(item.id)
            return (
              <li key={item.id} className="border-b">
                <button
                  type="button"
                  aria-pressed={off}
                  onClick={() => toggle(item.id)}
                  className={`flex w-full items-baseline justify-between gap-3 py-3 text-left ${off ? 'text-neutral-400 line-through' : ''}`}
                >
                  <span>
                    <span className="text-lg">{item.answerPl}</span>
                    {' — '}
                    <span>{item.glossRu}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {item.kind === 'fraza' ? t.kindPhrase : t.kindWord}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {(view.state === 'ready' || view.state === 'idle') && (
        <div className="flex flex-col gap-3">
          <BatchSettings value={params} onChange={setParams} />
          <div className="flex gap-3">
            {/* Was acceptAndMore/acceptAndFinish — those strings are removed
                (spec 2026-09-19-topic-items §4.6). This page is rewritten in
                Task 6/7 for the grouped view; this is a minimal compile fix. */}
            <button type="button" disabled={busy} onClick={() => accept(true)} className="rounded bg-black px-4 py-2 text-white disabled:opacity-40">
              {t.more}
            </button>
            {view.state === 'ready' && (
              <button type="button" disabled={busy} onClick={() => accept(false)} className="rounded border px-4 py-2 disabled:opacity-40">
                {t.add}
              </button>
            )}
          </div>
        </div>
      )}

      {saveError && <p className="text-sm text-red-600">{t.topicSaveFailed}</p>}

      <ul>
        {view.pending.map((p) => (
          <li key={`pending:${p.id}`} className="flex items-baseline justify-between gap-3 border-b py-3 text-neutral-500">
            <span className="text-lg">{p.transcript}</span>
            <span className="shrink-0 text-xs">{p.status === 'generating' ? t.generating : t.queued}</span>
          </li>
        ))}
        {view.cards.map((c) => (
          <CardListItem key={c.id} card={c} topicSuspended={topic.suspendedAt !== null} />
        ))}
      </ul>
    </div>
  )
}
