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
  // Important review finding (A3): patch/delete on this page previously
  // ignored the response status entirely — a rejected PATCH (or a failed
  // DELETE) looked identical to a successful one, and since the fields are
  // uncontrolled `defaultValue` inputs, a rejected edit stayed on screen as
  // if it had been saved.
  const [saveError, setSaveError] = useState(false)
  // Keyed by card id, same reasoning as formsError: one row's failed repair
  // must not paint an error on every other row.
  const [regenError, setRegenError] = useState<Record<string, boolean>>({})
  const [regenDuplicate, setRegenDuplicate] = useState<Record<string, boolean>>({})

  const load = useCallback(async (query: string) => {
    const res = await fetch(`/api/cards?q=${encodeURIComponent(query)}`)
    setRows((await res.json()).cards)
  }, [])

  useEffect(() => {
    void load(q)
  }, [q, load])

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    setSaveError(false)
    void load(q)
  }

  async function del(id: string) {
    const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    setSaveError(false)
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

  // A card is `needs_input` only because generation failed — most likely a
  // transient Vertex 429. Neither other recovery route repairs it (retry
  // returns early once a capture has a card; re-dictation dedups into this
  // card without writing the prompt), and hand-editing assumes you already
  // know the Russian the card exists to teach you.
  async function regenerate(id: string) {
    const res = await fetch(`/api/cards/${id}/regeneruj`, { method: 'POST' })
    if (!res.ok) {
      setRegenError((prev) => ({ ...prev, [id]: true }))
      return
    }
    const { duplicateOf } = (await res.json()) as { duplicateOf: string | null }
    setRegenError((prev) => {
      if (!(id in prev)) return prev
      const rest = { ...prev }
      delete rest[id]
      return rest
    })
    setRegenDuplicate((prev) => ({ ...prev, [id]: duplicateOf !== null }))
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
      {saveError && <p className="text-sm text-red-600">{t.saveFailed}</p>}
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
              {c.status === 'needs_input' && (
                <button onClick={() => void regenerate(c.id)} className="underline">
                  {t.regenerate}
                </button>
              )}
              <button onClick={() => void patch(c.id, { suspendedAt: c.suspendedAt ? null : Date.now() })} className="underline">
                {c.suspendedAt ? t.unsuspend : t.suspend}
              </button>
              <button onClick={() => void del(c.id)} className="underline text-red-600">
                {t.deleteItem}
              </button>
            </div>
            {formsError[c.id] && <p className="text-sm text-red-600">{t.formsFailed}</p>}
            {regenError[c.id] && <p className="text-sm text-red-600">{t.regenerateFailed}</p>}
            {regenDuplicate[c.id] && <p className="text-sm text-amber-600">{t.regenerateDuplicate}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
