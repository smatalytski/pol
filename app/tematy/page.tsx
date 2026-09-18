'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/** Every topic, with its card count, what is still generating, and its on/off switch (spec §4.2). */
export default function TopicsPage() {
  const [topics, setTopics] = useState<TopicListRow[]>([])

  const load = useCallback(async () => {
    const res = await fetch('/api/topics')
    setTopics(((await res.json()) as { topics: TopicListRow[] }).topics)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pending = topics.some((x) => x.pendingCount > 0)
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [pending, load])

  async function toggle(topic: TopicListRow) {
    await fetch(`/api/topics/${topic.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suspendedAt: topic.suspendedAt === null ? Date.now() : null }),
    }).catch(() => {})
    await load().catch(() => {})
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/tematy/nowy" className="self-start rounded bg-black px-4 py-2 text-white">
        {t.newTopic}
      </Link>
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
                {x.suspendedAt === null ? t.topicOn : t.topicOff}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
