'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { BatchSettings } from '@/components/BatchSettings'
import { ManualAddBar } from '@/components/ManualAddBar'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { RefreshCw, Sparkles } from '@/components/ui/icons'
import { DEFAULT_COUNT, type BatchParams } from '@/lib/topics/rounds'
import type { TopicView } from '@/lib/topics/service'
import { t } from '@/i18n/pl'
import { CardedTab, DiscardedTab, OpenTab, type Act } from './groups'

type Tab = 'carded' | 'open' | 'discarded'
const TABS: readonly Tab[] = ['carded', 'open', 'discarded']

const tabKey = (id: string) => `fiszki:tab:${id}`

/** The tab last used for this topic, if the browser kept it. Storage may be unavailable. */
function storedTab(id: string): Tab | null {
  try {
    const v = localStorage.getItem(tabKey(id))
    return TABS.find((tab) => tab === v) ?? null
  } catch {
    return null
  }
}

/**
 * What a failed write says to the user: a 409's own message (the server's
 * 409 texts are Polish), otherwise the generic `nie udało się zapisać` —
 * the other error texts are English and never shown.
 */
async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.ok) return null
    if (res.status === 409) {
      const payload = (await res.json().catch(() => null)) as { error?: unknown } | null
      if (typeof payload?.error === 'string') return payload.error
    }
    return t.topicSaveFailed
  } catch {
    return t.topicSaveFailed
  }
}

/**
 * One topic (spec 2026-09-19-topic-items §5.2): its header, and its items
 * and cards in three groups — with a card, without one, and discarded —
 * each with its own actions. Every action reloads the view.
 */
export default function TopicPage() {
  const { id } = useParams<{ id: string }>()
  const [view, setView] = useState<TopicView | null>(null)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [tab, setTab] = useState<Tab | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [params, setParams] = useState<BatchParams>({ count: DEFAULT_COUNT, mix: 'mieszane', level: 'zaawansowany' })

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
      if (!body || typeof body !== 'object' || !body.topic || !body.groups) throw new Error('malformed topic view')
      setView(body)
      setLoadError(false)
      // The first time, open on "bez karty" if there is anything in it.
      setTab((cur) => cur ?? storedTab(id) ?? (body.groups.open.length > 0 ? 'open' : 'carded'))
    } catch {
      setLoadError(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const waiting = view !== null && (view.batch.state === 'searching' || view.pending.length > 0)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void load(), 2_000)
    return () => clearInterval(timer)
  }, [waiting, load])

  function choose(next: Tab) {
    setTab(next)
    try {
      localStorage.setItem(tabKey(id), next)
    } catch {
      // Remembering the tab is a convenience; without storage it just isn't kept.
    }
  }

  // One write for the row `key`: its buttons are disabled while in flight,
  // a failure is shown, and the view reloads either way.
  const act: Act = async (key, url, method, body) => {
    setBusy((s) => new Set(s).add(key))
    setSaveError(null)
    const error = await send(url, method, body)
    setSaveError(error)
    await load()
    setBusy((s) => {
      const next = new Set(s)
      next.delete(key)
      return next
    })
  }

  async function addItem(text: string): Promise<string | null> {
    const error = await send(`/api/topics/${id}/items`, 'POST', { text })
    await load()
    return error
  }

  if (missing) return <p>{t.topicNotFound}</p>
  if (!view) return loadError ? <p className="text-sm text-red-600">{t.topicsLoadFailed}</p> : null
  const { topic, groups, pending, batch } = view
  const patchTopic = (fields: Record<string, unknown>) => void act('topic', `/api/topics/${id}`, 'PATCH', fields)
  const counts: Record<Tab, number> = {
    carded: groups.carded.length + pending.length,
    open: groups.open.length,
    discarded: groups.discarded.length,
  }
  const labels: Record<Tab, string> = { carded: t.tabCarded, open: t.tabOpen, discarded: t.tabDiscarded }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy" className="inline-flex min-h-8 items-center self-start text-sub text-neutral-500">{t.backToTopics}</Link>

      <div className="flex items-center justify-between gap-3">
        <input
          key={topic.name ?? ''}
          defaultValue={topic.name ?? ''}
          placeholder={t.unnamedTopic}
          disabled={topic.isDefault}
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (name && name !== topic.name) patchTopic({ name })
          }}
          className="min-w-0 flex-1 bg-transparent text-xl font-bold disabled:bg-transparent"
        />
        <Switch
          checked={topic.suspendedAt === null}
          label={t.topicOn}
          onChange={() => patchTopic({ suspendedAt: topic.suspendedAt === null ? Date.now() : null })}
        />
      </div>

      {!topic.isDefault && (
        <details>
          <summary className="text-sm text-neutral-500">{t.topicContext}</summary>
          <textarea
            key={topic.context}
            defaultValue={topic.context}
            rows={3}
            onBlur={(e) => {
              const context = e.target.value.trim()
              if (context && context !== topic.context) patchTopic({ context })
            }}
            className="mt-2 w-full rounded-lg border border-neutral-300 p-2"
          />
        </details>
      )}

      {loadError && <p className="text-sm text-red-600">{t.topicsLoadFailed}</p>}

      <div className="flex rounded-lg border border-neutral-300 p-0.5 text-sm">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => choose(key)}
            className={`flex-1 rounded-md px-2 py-1.5 tabular-nums ${tab === key ? 'bg-black font-semibold text-white' : 'text-neutral-600'}`}
          >
            {`${labels[key]} (${counts[key]})`}
          </button>
        ))}
      </div>

      {saveError && <p className="text-sm text-red-600">{saveError}</p>}

      {tab === 'carded' && (
        <CardedTab topicId={id} cards={groups.carded} pending={pending} topicSuspended={topic.suspendedAt !== null} busy={busy} act={act} />
      )}

      {tab === 'open' && (
        <div className="flex flex-col gap-4">
          <ManualAddBar onAdd={addItem} />
          <OpenTab topicId={id} items={groups.open} busy={busy} act={act} />
          {!topic.isDefault && (
            <div className="flex flex-col gap-3">
              {batch.state === 'searching' && <p className="text-sub text-neutral-500">{t.searching}</p>}
              {batch.state === 'failed' && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sub text-red-600">{batch.error}</p>
                  <Button variant="secondary" icon={RefreshCw} label={t.tryAgain} busy={busy.has('batch')} onClick={() => void act('batch', `/api/topics/${id}/retry`, 'POST')} />
                </div>
              )}
              <BatchSettings value={params} onChange={setParams} />
              <Button
                variant="primary"
                size="md"
                icon={Sparkles}
                label={t.more}
                busy={busy.has('batch')}
                disabled={batch.state === 'searching'}
                onClick={() => void act('batch', `/api/topics/${id}/batches`, 'POST', params)}
                className="self-start"
              />
            </div>
          )}
        </div>
      )}

      {tab === 'discarded' && <DiscardedTab topicId={id} entries={groups.discarded} busy={busy} act={act} />}
    </div>
  )
}
