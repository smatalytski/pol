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

export type DuplicateLookup = {
  type: CardType
  answerPl: string
  fallbackAnswerKey?: string
}

/**
 * Looks up an existing card for `answerPl`/`fallbackAnswerKey` without creating
 * anything. Split out of `createCard` so a caller whose duplicate check has a
 * side effect it wants to avoid paying on the duplicate path — e.g. the image
 * route, which must not store a media blob for a photo that turns out to
 * duplicate an existing card — can check first and only do that side effect
 * when it's actually about to create a card. `createCard` itself calls this
 * so there is exactly one implementation of the dedup logic, not two.
 */
export function findDuplicate(db: Db, input: DuplicateLookup): string | null {
  const key = answerKey(input.answerPl)
  // Dedup is scoped by (answer_key, type), not by answer_key alone. Before this
  // function existed, the capture pipeline inlined this same lookup scoped only
  // by answer_key — that was never wrong, merely untested at the boundary,
  // because the pipeline is the only caller and only ever creates `ru_to_pl`
  // cards, so a type filter was a no-op there. Now that this is shared with the
  // image route (`image_to_pl`) and, eventually, a forms path (`pl_forms`), the
  // type scope is a deliberate behavior change: a photo of a word and a
  // dictation of the same word are different exercises with different
  // retrieval cues (recognize an image vs. recall from a Russian prompt), and
  // spec §3 treats the card types as distinct. Without this scope, dropping a
  // photo of an already-dictated word would silently produce no new card, with
  // no way for the user to tell why.
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

  return existing ? existing.id : null
}

export function createCard(
  db: Db,
  input: CreateCardInput,
  now: Date,
): { cardId: string; duplicateOf: string | null } {
  const existingId = findDuplicate(db, {
    type: input.type,
    answerPl: input.answerPl,
    fallbackAnswerKey: input.fallbackAnswerKey,
  })
  if (existingId) return { cardId: existingId, duplicateOf: existingId }

  const key = answerKey(input.answerPl)
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
