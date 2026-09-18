'use client'
import type { CardType } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

const OPTIONS: ReadonlyArray<{ type: CardType; label: string }> = [
  { type: 'ru_to_pl', label: t.typeRuPl },
  { type: 'pl_to_pl', label: t.typePlPl },
]

/**
 * `karta: ru→pl · tylko formy` (spec 2026-09-18 §7). The current type is
 * plain text, the other a button. Each button stops its own pointer events:
 * on a capture chip the <li> reads pointerdown+pointerup as a tap or a swipe,
 * so without this, pressing the switch could also delete the chip.
 * `disabled` greys the button out while something else is rebuilding the card.
 */
export function CardTypeSwitch({
  type,
  onChange,
  disabled = false,
}: {
  type: CardType
  onChange: (type: CardType) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-neutral-500">{t.typeLabel}</span>
      {OPTIONS.map((o) =>
        o.type === type ? (
          <span key={o.type} className="font-semibold">
            {o.label}
          </span>
        ) : (
          <button
            key={o.type}
            onClick={() => onChange(o.type)}
            disabled={disabled}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            className="underline disabled:text-neutral-400"
          >
            {o.label}
          </button>
        ),
      )}
    </div>
  )
}
