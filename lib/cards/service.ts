import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { cards } from '../db/schema'
import { newState } from '../scheduler'
import { answerKey } from './answer-key'
import type { Generator } from '../generate'

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
  //
  // Soft delete (decided 2026-09-16): a soft-deleted card must NOT be found
  // here. If it were, re-dictating a word you just deleted would silently
  // resolve to the invisible deleted card instead of creating a fresh, visible
  // one — indistinguishable, from the user's side, from the dictation being
  // dropped on the floor.
  let existing = db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.answerKey, key), eq(cards.type, input.type), isNull(cards.deletedAt)))
    .get()

  if (!existing && input.fallbackAnswerKey && input.fallbackAnswerKey !== key) {
    existing = db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.answerKey, input.fallbackAnswerKey), eq(cards.type, input.type), isNull(cards.deletedAt)))
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

export type CardRow = typeof cards.$inferSelect

export type UpdateCardPatch = Partial<
  Pick<
    CardRow,
    'promptText' | 'promptHint' | 'answerPl' | 'examplePl' | 'exampleRu' | 'grammarNote' | 'status' | 'suspendedAt'
  >
>

/**
 * Lists cards for the browse screen. Soft-deleted cards are excluded on both
 * branches (the empty-query listing and the filtered search) — the browse
 * screen is the one place a deleted card must never resurface, since that is
 * the whole point of §9's "the card disappears everywhere".
 */
export function searchCards(db: Db, query: string, limit = 200): CardRow[] {
  // Filters in JS, not SQL (minor review finding): SQLite's built-in
  // `lower()`/LIKE fold ASCII only, so 'Хитрый' LIKE '%хитр%' is false in
  // real SQLite — a capitalized Russian prompt (the primary prompt language)
  // would be unfindable by a lowercase query. JS's String.toLowerCase() is
  // Unicode-aware. The personal-scale data volume here makes fetching every
  // non-deleted row and filtering in-process the right tradeoff over a more
  // "efficient" query that is quietly wrong for half the app's content.
  const q = query.trim().toLowerCase()
  const rows = db.select().from(cards).where(isNull(cards.deletedAt)).orderBy(desc(cards.createdAt)).all()
  if (q === '') return rows.slice(0, limit)
  const matches = rows.filter(
    (c) =>
      c.answerPl.toLowerCase().includes(q) ||
      (c.promptText?.toLowerCase().includes(q) ?? false) ||
      c.answerKey.toLowerCase().includes(q),
  )
  return matches.slice(0, limit)
}

export function updateCard(db: Db, id: string, patch: UpdateCardPatch, now: Date): CardRow {
  // Soft delete (important review finding): a deleted card must be treated
  // as gone here too, the same as every other lookup in this file — without
  // this filter, PATCHing a deleted id's route returned 200 and silently
  // wrote fields (including the needs_input -> ready promotion below) to an
  // invisible row.
  const current = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), isNull(cards.deletedAt)))
    .get()
  if (!current) throw new Error(`no such card: ${id}`)

  const merged = { ...current, ...patch }
  // A needs_input card becomes reviewable the moment it has a prompt, so fixing
  // one by hand does not also require remembering to flip its status.
  const status =
    merged.status === 'needs_input' && (merged.promptText || merged.promptMediaId) ? 'ready' : merged.status

  db.update(cards)
    .set({
      promptText: merged.promptText,
      promptHint: merged.promptHint,
      answerPl: merged.answerPl,
      answerKey: answerKey(merged.answerPl),
      examplePl: merged.examplePl,
      exampleRu: merged.exampleRu,
      grammarNote: merged.grammarNote,
      status,
      suspendedAt: merged.suspendedAt,
      updatedAt: now.getTime(),
    })
    .where(eq(cards.id, id))
    .run()

  return db.select().from(cards).where(eq(cards.id, id)).get()!
}

/**
 * Soft delete (decided 2026-09-16, spec §7/§9): sets `deleted_at` rather than
 * removing the row, so `reviews` — the append-only log §7 depends on to
 * optimize FSRS parameters later and to let a scheduler bug be recovered from
 * by replay — survives. This supersedes an earlier version of this task's
 * brief (and of spec §9) that had this function hard-delete the card and
 * cascade its reviews; the decision note at the top of the task takes
 * precedence over that stale text.
 *
 * Like the rest of this project's writes, `now` is injected rather than read
 * from the clock here — the one deviation from the brief's literal
 * `deleteCard(db, id): void` signature, which had no way to record a
 * soft-delete timestamp at all.
 *
 * A no-op on an unknown id, like the DELETE route it backs: deleting
 * something already gone should not be an error.
 *
 * Cascades to the card's `pl_forms` child, if it has one (important review
 * finding): `createFormsCard` already treats `parent_card_id` as
 * authoritative in the other direction (its idempotent lookup is scoped by
 * parent), so deleting the parent while leaving the child `ready` would keep
 * drilling a word the user just told the app to forget — indistinguishable,
 * from the user's side, from the delete not having worked at all.
 */
export function deleteCard(db: Db, id: string, now: Date): void {
  db.update(cards)
    .set({ deletedAt: now.getTime() })
    .where(or(eq(cards.id, id), eq(cards.parentCardId, id)))
    .run()
}

export async function createFormsCard(
  db: Db,
  generator: Generator,
  parentId: string,
  now: Date,
): Promise<{ cardId: string; duplicateOf: string | null }> {
  const parent = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, parentId), isNull(cards.deletedAt)))
    .get()
  if (!parent) throw new Error(`no such card: ${parentId}`)
  // Important review finding: a pl_forms card's answer is a Markdown table,
  // never a lemma, and forms-of-forms has no meaning under spec §3's card
  // model. Rejected here (not just hidden behind a button in app/fiszki) so
  // this can't be triggered by a direct request to the route either.
  if (parent.type === 'pl_forms') {
    throw new Error(`cannot generate forms for a pl_forms card: ${parentId}`)
  }

  const existing = db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.parentCardId, parentId), eq(cards.type, 'pl_forms'), isNull(cards.deletedAt)))
    .get()
  if (existing) return { cardId: existing.id, duplicateOf: existing.id }

  const forms = await generator.forms(parent.answerPl)
  return createCard(
    db,
    {
      type: 'pl_forms',
      promptText: forms.prompt_pl,
      promptHint: null,
      promptMediaId: null,
      answerPl: forms.answer_pl,
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      parentCardId: parentId,
    },
    now,
  )
}
