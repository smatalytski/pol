'use client'
import { useState } from 'react'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/**
 * Moving an open or discarded item's card to another topic (spec
 * 2026-09-19-topic-items §4.4). The list is fetched fresh on every open, so
 * it can never show a topic that was renamed or deleted since the page
 * loaded.
 */
export function MoveToTopic({
  currentTopicId,
  onMove,
}: {
  currentTopicId: string
  onMove: (topicId: string) => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [topics, setTopics] = useState<TopicListRow[] | null>(null)
  const [error, setError] = useState(false)

  async function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setError(false)
    try {
      const res = await fetch('/api/topics')
      if (!res.ok) throw new Error()
      const body = (await res.json()) as { topics: TopicListRow[] }
      setTopics(body.topics)
      setOpen(true)
    } catch {
      setError(true)
    }
  }

  async function choose(topicId: string) {
    setOpen(false)
    await onMove(topicId)
  }

  return (
    <div className="relative inline-block text-sm">
      <button type="button" onClick={() => void toggle()} className="rounded border px-2 py-1">
        {t.moveTo}: …
      </button>
      {open && topics && (
        <div className="absolute z-10 mt-1 flex flex-col gap-1 rounded border bg-background p-1 shadow">
          {topics
            .filter((tp) => tp.id !== currentTopicId)
            .map((tp) => (
              <button
                key={tp.id}
                type="button"
                onClick={() => void choose(tp.id)}
                className="whitespace-nowrap px-2 py-1 text-left hover:bg-neutral-100"
              >
                {tp.name ?? t.unnamedTopic}
              </button>
            ))}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{t.topicSaveFailed}</p>}
    </div>
  )
}
