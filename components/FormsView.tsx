'use client'
import { useState } from 'react'
import type { CardForms, FormRow } from '@/lib/cards/forms'
import { t } from '@/i18n/pl'

function Rows({ rows }: { rows: FormRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-sm">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="contents">
          <dt className="text-neutral-500">{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A word's forms (spec 2026-09-18 §7): the basic list always, the extended
 * list behind a tap. The toggle is local state, so a parent that wants it
 * closed again for the next card re-mounts this with a `key`.
 */
export function FormsView({ forms }: { forms: CardForms | null }) {
  const [showAll, setShowAll] = useState(false)
  if (!forms) return null
  return (
    <div className="flex flex-col items-center gap-2">
      {forms.basic.length > 0 && <Rows rows={forms.basic} />}
      {forms.extended.length > 0 && (
        <>
          <button onClick={() => setShowAll((s) => !s)} className="text-sm underline">
            {showAll ? t.hideAllForms : t.showAllForms}
          </button>
          {showAll && <Rows rows={forms.extended} />}
        </>
      )}
    </div>
  )
}
