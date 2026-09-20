'use client'
import { COUNTS, LEVELS, MIXES, type BatchParams, type Level, type Mix } from '@/lib/topics/rounds'
import { t } from '@/i18n/pl'

const MIX_LABEL: Record<Mix, string> = { mieszane: t.mixMixed, slowa: t.mixWords, frazy: t.mixPhrases }
const LEVEL_LABEL: Record<Level, string> = { zaawansowany: t.levelAdvanced, sredni: t.levelIntermediate }

/** How big the next batch is, how it leans, and how hard it should be (spec 2026-09-19-topic-items §4.5). */
export function BatchSettings({ value, onChange }: { value: BatchParams; onChange: (p: BatchParams) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        {t.roundCount}
        <select
          value={value.count}
          onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
          className="rounded-lg border border-neutral-300 px-2 py-1"
        >
          {COUNTS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="flex rounded-lg border border-neutral-300 p-0.5">
        {MIXES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value.mix === m}
            onClick={() => onChange({ ...value, mix: m })}
            className={`min-h-8 rounded-md px-2 py-1 ${value.mix === m ? 'bg-primary text-white' : 'text-neutral-600'}`}
          >
            {MIX_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="flex rounded-lg border border-neutral-300 p-0.5">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={value.level === l}
            onClick={() => onChange({ ...value, level: l })}
            className={`min-h-8 rounded-md px-2 py-1 ${value.level === l ? 'bg-primary text-white' : 'text-neutral-600'}`}
          >
            {LEVEL_LABEL[l]}
          </button>
        ))}
      </div>
    </div>
  )
}
