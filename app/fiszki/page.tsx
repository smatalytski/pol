'use client'
import { useCallback, useEffect, useState } from 'react'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

export default function CardsPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CardRow[]>([])

  const load = useCallback(async (query: string) => {
    const res = await fetch(`/api/cards?q=${encodeURIComponent(query)}`)
    setRows((await res.json()).cards)
  }, [])

  useEffect(() => {
    void load(q)
  }, [q, load])

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    void load(q)
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="rounded border p-3"
        placeholder={t.cards}
      />
      <ul>
        {rows.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 border-b py-3">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-neutral-500">{c.promptText}</span>
              {c.status === 'needs_input' && <span className="text-sm text-amber-600">{t.needsInput}</span>}
            </div>
            <input
              defaultValue={c.answerPl}
              onBlur={(e) => e.target.value !== c.answerPl && void patch(c.id, { answerPl: e.target.value })}
              className="text-lg"
            />
            <div className="flex gap-3 text-sm">
              <button onClick={() => void fetch(`/api/cards/${c.id}/formy`, { method: 'POST' }).then(() => load(q))} className="underline">
                {t.addForms}
              </button>
              <button onClick={() => void patch(c.id, { suspendedAt: c.suspendedAt ? null : Date.now() })} className="underline">
                {c.suspendedAt ? t.unsuspend : t.suspend}
              </button>
              <button
                onClick={() => void fetch(`/api/cards/${c.id}`, { method: 'DELETE' }).then(() => load(q))}
                className="underline text-red-600"
              >
                {t.deleteItem}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
