'use client'
import { useCallback, useEffect, useState } from 'react'
import { CardListItem } from '@/components/CardListItem'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

type PendingRow = { id: string; transcript: string | null; status: 'queued' | 'generating' }

/**
 * Finding a card, and nothing else: one Polish title per row, plus a status
 * badge where there is something to say. Everything editable, and the answer
 * audio player, live on the card detail screen (app/fiszki/[id]/page.tsx) —
 * this screen used to carry all of it inline on every row, which left a list
 * that was hard to scan and had nowhere to put a player. Words approved and
 * waiting for, or in, generation are listed above the cards as plain rows —
 * they turn into cards on their own, so there is nothing here to link to.
 */
export default function CardsPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CardRow[]>([])
  const [pending, setPending] = useState<PendingRow[]>([])
  const [generatingIds, setGeneratingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [topicNames, setTopicNames] = useState<Record<string, string>>({})

  const load = useCallback(async (query: string) => {
    const res = await fetch(`/api/cards?q=${encodeURIComponent(query)}`)
    const body = (await res.json()) as {
      cards: CardRow[]
      pending: PendingRow[]
      generatingCardIds: string[]
      topicNames: Record<string, string>
    }
    setRows(body.cards)
    setPending(body.pending)
    setGeneratingIds(new Set(body.generatingCardIds))
    setTopicNames(body.topicNames)
  }, [])

  useEffect(() => {
    void load(q)
  }, [q, load])

  // Words waiting for generation turn into cards on their own (spec
  // 2026-09-18-generation-queue §7.2); poll while anything is still waiting.
  const waiting = pending.length > 0 || generatingIds.size > 0
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => void load(q), 2_000)
    return () => clearInterval(id)
  }, [waiting, q, load])

  const query = q.trim().toLowerCase()
  const visiblePending = pending.filter((p) => (p.transcript ?? '').toLowerCase().includes(query))

  return (
    <div className="flex flex-col gap-4">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="rounded border p-3"
        placeholder={t.cards}
      />
      <ul>
        {visiblePending.map((p) => (
          <li
            key={`pending:${p.id}`}
            className="flex items-baseline justify-between gap-3 border-b py-3 text-neutral-500"
          >
            <span className="text-lg">{p.transcript}</span>
            <span className="shrink-0 text-xs">{p.status === 'generating' ? t.generating : t.queued}</span>
          </li>
        ))}
        {rows.map((c) => (
          <CardListItem
            key={c.id}
            card={c}
            topicName={c.topicId ? topicNames[c.topicId] : null}
            generating={generatingIds.has(c.id)}
          />
        ))}
      </ul>
    </div>
  )
}
