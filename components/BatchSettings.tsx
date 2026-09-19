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
          className="rounded border p-1"
        >
          {COUNTS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="flex overflow-hidden rounded border">
        {MIXES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value.mix === m}
            onClick={() => onChange({ ...value, mix: m })}
            className={`px-2 py-1 ${value.mix === m ? 'bg-black text-white' : ''}`}
          >
            {MIX_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="flex overflow-hidden rounded border">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={value.level === l}
            onClick={() => onChange({ ...value, level: l })}
            className={`px-2 py-1 ${value.level === l ? 'bg-black text-white' : ''}`}
          >
            {LEVEL_LABEL[l]}
          </button>
        ))}
      </div>
    </div>
  )
}
