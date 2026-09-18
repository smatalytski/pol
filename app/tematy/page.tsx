'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/** Every topic, with its card count, what is still generating, and its on/off switch (spec §4.2). */
export default function TopicsPage() {
  const [topics, setTopics] = useState<TopicListRow[]>([])
  const [error, setError] = useState<string | null>(null)

  // A non-2xx or malformed body must never reach setTopics (it would leave
  // `topics` as something other than an array and crash the `.some`/`.map`
  // below), and neither this nor the polling interval that calls it may
  // throw out to an unhandled rejection — so every failure is caught here
  // and turned into an error line, leaving the previous list on screen.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/topics')
      const body: unknown = res.ok ? await res.json() : null
      const list = (body as { topics?: unknown } | null)?.topics
      if (!res.ok || !Array.isArray(list)) throw new Error('failed to load topics')
      setTopics(list as TopicListRow[])
      setError(null)
    } catch {
      setError(t.topicsLoadFailed)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A brand-new topic has no pending captures yet — it is still searching for
  // its first round — so it must keep the page polling too, or it sits at
  // "nowy temat…" until the page happens to reload.
  const pending = topics.some((x) => x.pendingCount > 0 || x.searching)
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [pending, load])

  async function toggle(topic: TopicListRow) {
    try {
      const res = await fetch(`/api/topics/${topic.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suspendedAt: topic.suspendedAt === null ? Date.now() : null }),
      })
      if (!res.ok) throw new Error('failed to switch topic')
      setError(null)
      await load()
    } catch {
      setError(t.topicSaveFailed)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy/nowy" className="self-start rounded bg-black px-4 py-2 text-white">
        {t.newTopic}
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul>
        {topics.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-3 border-b py-3">
            <Link href={`/tematy/${x.id}`} className={`text-lg ${x.suspendedAt !== null ? 'text-neutral-400' : ''}`}>
              {x.name ?? t.unnamedTopic}
            </Link>
            <span className="flex shrink-0 items-center gap-3 text-xs">
              <span>{x.cardCount}</span>
              {x.pendingCount > 0 && <span className="text-sky-700">{`+${x.pendingCount} ${t.queued}`}</span>}
              <button
                type="button"
                onClick={() => void toggle(x)}
                className="rounded border px-2 py-1"
              >
                {x.suspendedAt === null ? t.topicOn : t.topicOffToggle}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
