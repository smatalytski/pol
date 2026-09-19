'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { buttonClass } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Plus } from '@/components/ui/icons'
import { Switch } from '@/components/ui/Switch'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/** Every topic, with its card count, what is still generating, and its on/off switch (spec §5.1). */
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
  // its first batch — so it must keep the page polling too, or it sits at
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
      <Link href="/tematy/nowy" className={`${buttonClass('primary', 'md')} self-start`}>
        <Icon icon={Plus} />
        {t.newTopic}
      </Link>
      {error && <p className="text-sub text-red-600">{error}</p>}
      <ul>
        {topics.map((x) => (
          <li key={x.id} className="flex flex-col gap-2 border-b py-3">
            <Link href={`/tematy/${x.id}`} className={`break-words text-row ${x.suspendedAt !== null ? 'text-neutral-400' : ''}`}>
              {x.name ?? t.unnamedTopic}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className="tabular-nums">
                {`${x.cardCount} ${t.tabCarded} · ${x.openCount} ${t.tabOpen} · ${x.discardedCount} ${t.tabDiscarded}`}
              </span>
              {x.pendingCount > 0 && <Badge tone="sky">{`+${x.pendingCount} ${t.queued}`}</Badge>}
              <span className="ml-auto">
                <Switch checked={x.suspendedAt === null} label={t.topicOn} onChange={() => void toggle(x)} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
