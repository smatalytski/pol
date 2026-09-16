'use client'
import { useCallback, useEffect, useState } from 'react'
import type { CardRow } from '@/lib/cards/service'
import { FormsTable } from '@/components/FormsTable'
import { t } from '@/i18n/pl'

export default function CardsPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CardRow[]>([])
  // Important review finding: the formy route now returns a real error on a
  // generation failure — not a rare case, the exact outcome this task's own
  // sandbox produced live — but nothing surfaced it. Keyed by card id so one
  // row's failure doesn't paint an error on every row.
  const [formsError, setFormsError] = useState<Record<string, boolean>>({})

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

  async function addForms(id: string) {
    const res = await fetch(`/api/cards/${id}/formy`, { method: 'POST' })
    if (!res.ok) {
      setFormsError((prev) => ({ ...prev, [id]: true }))
      return
    }
    setFormsError((prev) => {
      if (!(id in prev)) return prev
      const rest = { ...prev }
      delete rest[id]
      return rest
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
              {/* Important review finding: needs_input is produced ONLY by a
                  failed generation — exactly when it can't be fixed
                  immediately — and the only other prompt editor lives in the
                  capture chip, reachable solely inside /dodaj's 60-second
                  `since` window. Without an editable field here, a
                  needs_input card was permanently stuck out of review after
                  one reload. updateCard already promotes needs_input -> ready
                  the moment a prompt lands; this just gives it a durable way
                  to arrive. */}
              <input
                defaultValue={c.promptText ?? ''}
                onBlur={(e) => e.target.value !== (c.promptText ?? '') && void patch(c.id, { promptText: e.target.value })}
                placeholder={t.needsInput}
                className="text-sm text-neutral-500"
              />
              {c.status === 'needs_input' && <span className="text-sm text-amber-600">{t.needsInput}</span>}
            </div>
            {c.type === 'pl_forms' ? (
              // Critical review finding: an <input>'s value-sanitization
              // algorithm strips CR/LF, so a forms table's real newlines
              // never survive round-tripping through an editable <input>'s
              // defaultValue — the very next unrelated blur would PATCH the
              // flattened string over the only copy of the table, with no
              // undo and no other place the original Markdown is stored.
              // Render it read-only, through the same FormsTable the review
              // screen uses, instead of ever making it an editable text field.
              <FormsTable markdown={c.answerPl} />
            ) : (
              <input
                defaultValue={c.answerPl}
                onBlur={(e) => e.target.value !== c.answerPl && void patch(c.id, { answerPl: e.target.value })}
                className="text-lg"
              />
            )}
            <div className="flex gap-3 text-sm">
              {/* Important review finding: a pl_forms answer is a Markdown
                  table, not a lemma — createFormsCard now rejects a pl_forms
                  parent, but the button was still offered here, which would
                  burn a model call on a nonsense request before hitting that
                  rejection. */}
              {c.type !== 'pl_forms' && (
                <button onClick={() => void addForms(c.id)} className="underline">
                  {t.addForms}
                </button>
              )}
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
            {formsError[c.id] && <p className="text-sm text-red-600">{t.formsFailed}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
