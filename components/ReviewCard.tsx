'use client'
import type { QueueItem } from '@/lib/review/queue'
import type { RatingValue } from '@/lib/scheduler'
import { t } from '@/i18n/pl'

const RATINGS: ReadonlyArray<{ value: RatingValue; label: string }> = [
  { value: 1, label: t.again },
  { value: 2, label: t.hard },
  { value: 3, label: t.good },
  { value: 4, label: t.easy },
]

// Mirrors GET /api/cards/:id/audio's eligibility table exactly (Task 11): the
// answer route 404s for pl_forms, whose answer is a declension table that is
// never spoken. A play control here for that type would be a dead button on
// every forms card.
function hasAnswerAudio(type: QueueItem['type']): boolean {
  return type !== 'pl_forms'
}

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
  return (
    <div className="flex min-h-[70vh] flex-col gap-6">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        {card.promptMediaId ? (
          <img src={`/api/media/${card.promptMediaId}`} alt={t.imagePrompt} className="max-h-64 rounded" />
        ) : (
          <p className="text-3xl">{card.promptText}</p>
        )}
        {card.promptHint && <p className="text-sm text-neutral-500">{card.promptHint}</p>}

        {revealed && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-3xl font-semibold">{card.answerPl}</p>
            {hasAnswerAudio(card.type) && (
              <audio controls preload="none" src={`/api/cards/${card.id}/audio?part=answer`} aria-label={t.play} />
            )}
            {card.examplePl && <p className="text-lg">{card.examplePl}</p>}
            {card.exampleRu && <p className="text-sm text-neutral-500">{card.exampleRu}</p>}
            {card.grammarNote && <p className="text-sm text-neutral-500">{card.grammarNote}</p>}
          </div>
        )}
      </div>

      {revealed ? (
        <div className="grid grid-cols-4 gap-2">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              onClick={() => onRate(r.value)}
              className="rounded border p-4 text-sm"
            >
              {r.label}
            </button>
          ))}
        </div>
      ) : (
        <button onClick={onReveal} className="rounded bg-black p-5 text-lg text-white">
          {t.show}
        </button>
      )}

      {canUndo && (
        <button onClick={onUndo} className="self-center text-sm underline">
          {t.undo}
        </button>
      )}
    </div>
  )
}
