'use client'
import type { QueueItem } from '@/lib/review/queue'
import type { RatingValue } from '@/lib/scheduler'
import { FormsTable } from './FormsTable'
import { hasAnswerAudio } from '@/lib/cards/display'
import { t } from '@/i18n/pl'

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
  return (
    <div className="flex min-h-[70vh] flex-col gap-6">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-3xl">{card.promptText}</p>
        {card.promptHint && <p className="text-sm text-neutral-500">{card.promptHint}</p>}

        {revealed && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {card.type === 'pl_forms' ? (
              <FormsTable markdown={card.answerPl} />
            ) : (
              <p className="text-3xl font-semibold">{card.answerPl}</p>
            )}
            {hasAnswerAudio(card.type) && (
              <audio controls preload="none" src={`/api/cards/${card.id}/audio?part=answer`} aria-label={t.play} />
            )}
            {card.examplePl && <p className="text-lg">{card.examplePl}</p>}
            {/* No Russian on the answer side. The Russian prompt above is the
                retrieval cue; once the card is turned over, a Russian gloss of
                the Polish example just gives the eye an easier place to land
                than the Polish it is supposed to be reading. `exampleRu` is
                still generated and stored — ten existing cards hold real
                values, and dropping the column is a migration with nothing
                user-visible to show for it. */}
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
