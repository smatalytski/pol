'use client'
import type { QueueItem } from '@/lib/review/queue'
import type { RatingValue } from '@/lib/scheduler'
import { t } from '@/i18n/pl'
import { FormsView } from './FormsView'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Eye, Undo2 } from '@/components/ui/icons'

const RATINGS: ReadonlyArray<{ value: RatingValue; label: string }> = [
  { value: 1, label: t.again },
  { value: 2, label: t.hard },
  { value: 3, label: t.good },
  { value: 4, label: t.easy },
]

export function ReviewCard({
  card,
  revealed,
  canUndo,
  onReveal,
  onRate,
  onUndo,
}: {
  card: QueueItem
  revealed: boolean
  canUndo: boolean
  onReveal: () => void
  onRate: (rating: RatingValue) => void
  onUndo: () => void
}) {
  const isForms = card.type === 'pl_to_pl'
  return (
    <div className="flex min-h-[70vh] flex-col gap-6">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        {/* A pl_to_pl card asks with the Polish word itself, and carries no
            Russian anywhere (spec 2026-09-18 §2). */}
        <p className="text-3xl">{isForms ? card.answerPl : card.promptText}</p>
        {!isForms && card.promptHint && <p className="text-sub text-neutral-500">{card.promptHint}</p>}

        {revealed && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {!isForms && <p className="text-3xl font-semibold">{card.answerPl}</p>}
            <audio controls preload="none" src={`/api/cards/${card.id}/audio?part=answer`} aria-label={t.play} />
            {/* Keyed on the card, so the extended toggle closes again for the
                next card instead of staying open for every one after it. */}
            <FormsView key={card.id} forms={card.forms} />
            {/* For a ru_to_pl card, the Russian prompt above is the retrieval
                cue, so no Russian gloss of the example is shown here on the
                answer side (exampleRu stays stored but unrendered). */}
            {!isForms && card.examplePl && <p className="text-lg">{card.examplePl}</p>}
            {card.grammarNote && <p className="text-sub text-neutral-500">{card.grammarNote}</p>}
          </div>
        )}
      </div>

      {revealed ? (
        <div className="grid grid-cols-4 gap-2">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              onClick={() => onRate(r.value)}
              className="h-14 rounded-lg border border-neutral-300 text-sm"
            >
              {r.label}
            </button>
          ))}
        </div>
      ) : (
        <button onClick={onReveal} className="flex h-14 items-center justify-center gap-2 rounded-lg bg-black text-lg text-white">
          <Icon icon={Eye} />
          {t.show}
        </button>
      )}

      {canUndo && <Button variant="icon" icon={Undo2} label={t.undo} onClick={onUndo} className="self-center" />}
    </div>
  )
}
