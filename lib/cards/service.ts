import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { cards } from '../db/schema'
import { newState } from '../scheduler'
import { answerKey } from './answer-key'

export type CardType = 'ru_to_pl' | 'image_to_pl' | 'pl_forms'

export type CreateCardInput = {
  type: CardType
  promptText: string | null
  promptHint: string | null
  promptMediaId: string | null
  answerPl: string
  examplePl: string | null
  exampleRu: string | null
  grammarNote: string | null
  status: 'ready' | 'needs_input'
  parentCardId: string | null
  /**
   * A caller-supplied secondary answer-key, consulted only when the primary
   * lookup on `answerKey(answerPl)` finds nothing. This exists for the
   * capture pipeline (lib/capture/pipeline.ts): a word that first lands as
   * needs_input is keyed by its raw transcript, but a later successful
   * re-dictation is keyed by the diacritic-restored answer_pl — a different
   * string — so the primary lookup alone would miss the earlier card and
   * silently fork the word into a second one, orphaning the first. The
   * pipeline passes `answerKey(transcript)` here on its success path; a
   * caller with no secondary key (e.g. the image route, which has no
   * transcript) simply omits it. The primary match always wins: this is
   * only ever consulted when the primary lookup found nothing.
   */
  fallbackAnswerKey?: string
}

export function createCard(
  db: Db,
  input: CreateCardInput,
  now: Date,
): { cardId: string; duplicateOf: string | null } {
  const key = answerKey(input.answerPl)
  let existing = db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.answerKey, key), eq(cards.type, input.type)))
    .get()

  if (!existing && input.fallbackAnswerKey && input.fallbackAnswerKey !== key) {
    existing = db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.answerKey, input.fallbackAnswerKey), eq(cards.type, input.type)))
      .get()
  }

  if (existing) return { cardId: existing.id, duplicateOf: existing.id }

  const cardId = randomUUID()
  db.insert(cards)
    .values({
      id: cardId,
      type: input.type,
      promptText: input.promptText,
      promptHint: input.promptHint,
      promptMediaId: input.promptMediaId,
      answerPl: input.answerPl,
      answerKey: key,
      examplePl: input.examplePl,
      exampleRu: input.exampleRu,
      grammarNote: input.grammarNote,
      status: input.status,
      parentCardId: input.parentCardId,
      suspendedAt: null,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      ...newState(now),
    })
    .run()
  return { cardId, duplicateOf: null }
}
