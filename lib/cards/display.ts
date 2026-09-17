import type { CardType } from './service'

/**
 * The one-line Polish label for a card, used by the browse list and the card
 * detail screen. Structural input rather than a full CardRow, so a QueueItem
 * works here too.
 *
 * A pl_forms card is the whole reason this is a function and not a field read:
 * its `answerPl` is a Markdown declension table, which collapses into an
 * unreadable line of pipes, while its `promptText` is already a Polish label
 * ("patrzeć — odmiana czasownika").
 */
export function cardTitle(card: {
  type: CardType
  promptText: string | null
  answerPl: string
}): string {
  if (card.type === 'pl_forms') return card.promptText ?? card.answerPl
  return card.answerPl
}

/**
 * Mirrors GET /api/cards/:id/audio's eligibility table exactly: the answer
 * route 404s for pl_forms, whose answer is a declension table that is never
 * spoken (spec section 6). A play control for that type would be a dead
 * button on every forms card.
 */
export function hasAnswerAudio(type: CardType): boolean {
  return type !== 'pl_forms'
}
