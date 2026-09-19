'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FolderInput } from '@/components/ui/icons'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/**
 * Moving a card or an open/discarded item to another topic (spec
 * 2026-09-19-topic-items §4.4). The list is fetched fresh on every open, so
 * it can never show a topic that was renamed since the page loaded — topics
 * are never deleted. `currentName` is the caller's already-known name for
 * `currentTopicId`; the button reads `…` until a caller has one to show.
 * `compact` (topic-page rows) draws the trigger as an icon button named
 * `temat`; without it (the card page) the trigger reads `temat: <name>`.
 */
export function MoveToTopic({
  currentTopicId,
  currentName,
  onMove,
  compact,
}: {
  currentTopicId: string
  currentName?: string | null
  onMove: (topicId: string) => Promise<void> | void
  compact?: boolean
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

  // Not `relative` itself: on a narrow phone the panel needs the width of
  // the whole row, not just this button, so it is positioned against the
  // nearest ancestor the caller has made `relative` (the row) instead.
  return (
    <div className="inline-block text-sm">
      <Button
        variant={compact ? 'icon' : 'secondary'}
        icon={FolderInput}
        label={compact ? t.moveTo : `${t.moveTo}: ${currentName !== undefined ? (currentName ?? t.unnamedTopic) : '…'}`}
        onClick={() => void toggle()}
      />
      {open && topics && (
        <div className="absolute inset-x-0 z-10 mt-1 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-neutral-300 bg-background p-1 shadow">
          {topics
            .filter((tp) => tp.id !== currentTopicId)
            .map((tp) => (
              <button
                key={tp.id}
                type="button"
                onClick={() => void choose(tp.id)}
                className="w-full break-words px-2 py-1 text-left hover:bg-neutral-100"
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
