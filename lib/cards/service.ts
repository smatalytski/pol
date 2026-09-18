import { and, desc, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { cards } from '../db/schema'
import { newState } from '../scheduler'
import { answerKey } from './answer-key'
import { toCardFields, type Generator } from '../generate'
import { canDrillForms, type WordKind } from './forms'

export type CardType = 'ru_to_pl' | 'pl_to_pl'

export type CreateCardInput = {
  type: CardType
  promptText: string | null
  promptHint: string | null
  answerPl: string
  examplePl: string | null
  exampleRu: string | null
  grammarNote: string | null
  wordKind: WordKind | null
  formsJson: string | null
  status: 'ready' | 'needs_input'
  /**
   * A caller-supplied secondary answer-key, consulted only when the primary
   * lookup on `answerKey(answerPl)` finds nothing. This exists for the
   * capture pipeline (lib/capture/pipeline.ts): a word that first lands as
   * needs_input is keyed by its raw transcript, but a later successful
   * re-dictation is keyed by the diacritic-restored answer_pl — a different
   * string — so the primary lookup alone would miss the earlier card and
   * silently fork the word into a second one, orphaning the first. The
   * pipeline passes `answerKey(transcript)` here on its success path; a
   * caller with no secondary key (e.g. POST /api/cards, which has no
   * transcript) simply omits it. The primary match always wins: this is
   * only ever consulted when the primary lookup found nothing.
   */
  fallbackAnswerKey?: string
  /** The topic a generated item belongs to (spec 2026-09-18-topic-generation §3.4). A duplicate keeps its own. */
  topicId?: string | null
}

export type DuplicateLookup = {
  type: CardType
  answerPl: string
  fallbackAnswerKey?: string
}

/**
 * Looks up an existing card for `answerPl`/`fallbackAnswerKey` without creating
 * anything. Split out of `createCard` so a caller can check for a duplicate
 * before doing whatever creating or updating a card would otherwise trigger:
 * `createCard` calls it before inserting a new row, and `applyGeneratedFields`
 * calls it before re-keying a card, so there is exactly one implementation of
 * the dedup logic, not two.
 */
export function findDuplicate(db: Db, input: DuplicateLookup): string | null {
  const key = answerKey(input.answerPl)
  // Dedup is scoped by (answer_key, type): the same word may exist as a
  // ru_to_pl card (recall it from Russian) and a pl_to_pl card (recall its
  // forms), because those are different exercises (spec 2026-09-18 §2).
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
      answerPl: input.answerPl,
      answerKey: key,
      examplePl: input.examplePl,
      exampleRu: input.exampleRu,
      grammarNote: input.grammarNote,
      wordKind: input.wordKind,
      formsJson: input.formsJson,
      status: input.status,
      topicId: input.topicId ?? null,
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
    | 'type'
    | 'promptText'
    | 'promptHint'
    | 'answerPl'
    | 'examplePl'
    | 'exampleRu'
    | 'grammarNote'
    | 'wordKind'
    | 'formsJson'
    | 'status'
    | 'suspendedAt'
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
  const status = merged.status === 'needs_input' && merged.promptText ? 'ready' : merged.status

  db.update(cards)
    .set({
      type: merged.type,
      promptText: merged.promptText,
      promptHint: merged.promptHint,
      answerPl: merged.answerPl,
      answerKey: answerKey(merged.answerPl),
      examplePl: merged.examplePl,
      exampleRu: merged.exampleRu,
      grammarNote: merged.grammarNote,
      wordKind: merged.wordKind,
      formsJson: merged.formsJson,
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
 */
export function deleteCard(db: Db, id: string, now: Date): void {
  db.update(cards).set({ deletedAt: now.getTime() }).where(eq(cards.id, id)).run()
}

/**
 * Repairs a card stranded by a failed generation. A generation job that gives
 * up produces one: the capture pipeline deliberately keeps the word and marks
 * the card `needs_input` rather than losing the dictation (`giveUpNewCard`),
 * but neither of the other recovery routes actually repairs it — a recording
 * that has a card is never generated again as new (`generateNewCard` returns
 * early), and re-dictating dedups into the stranded card without writing the
 * new prompt. That left hand-typing the Russian as
 * the only fix, which assumes the user already knows the very thing the card
 * exists to teach them.
 *
 * In that state `answer_pl` holds the raw transcript, so it is what goes back
 * to the model.
 */
export async function regenerateCard(
  db: Db,
  generator: Generator,
  id: string,
  now: Date,
): Promise<{ card: CardRow; duplicateOf: string | null }> {
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), isNull(cards.deletedAt)))
    .get()
  if (!card) throw new Error(`no such card: ${id}`)
  // Restricted to needs_input (not merely hidden behind a button in
  // app/fiszki), so a direct request cannot re-roll a card whose content is
  // already good — this function overwrites every generated field.
  if (card.status !== 'needs_input') {
    throw new Error(`can only regenerate a needs_input card: ${id}`)
  }

  const fields = toCardFields(await generator.fromDictation(card.answerPl))
  // On a clash the card keeps its answer and still gets what was missing —
  // see applyGeneratedFields's doc comment.
  return applyGeneratedFields(db, card, fields, now)
}

/** The eight fields a generation produces, as `toCardFields` returns them. */
export type GeneratedFields = {
  promptText: string | null
  promptHint: string | null
  answerPl: string
  examplePl: string | null
  exampleRu: string | null
  grammarNote: string | null
  wordKind: WordKind | null
  formsJson: string | null
}

/** A type switch the card cannot take — answered as a 400, not a crash. */
export class CardTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardTypeError'
  }
}

/**
 * Switches a card between ru_to_pl and pl_to_pl (spec 2026-09-18 §6). Costs no
 * model call: one generation already stored everything both types need, and
 * `prompt_text` keeps the Russian either way, so switching back restores the
 * ru_to_pl card exactly.
 *
 * Resets the schedule, because the recall task changed — the schedule earned
 * by recalling a word from Russian says nothing about recalling its forms.
 * Review rows are kept. In practice the switch happens right after dictation,
 * before any review.
 */
export function setCardType(
  db: Db,
  id: string,
  type: CardType,
  now: Date,
): { card: CardRow; duplicateOf: string | null } {
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), isNull(cards.deletedAt)))
    .get()
  if (!card) throw new Error(`no such card: ${id}`)
  if (card.type === type) return { card, duplicateOf: null }

  // A pl_to_pl card's whole answer is its forms. Checked on the stored forms
  // too, not only the kind: a noun whose generation returned no rows would
  // become a forms card with nothing on its answer side.
  if (type === 'pl_to_pl' && !canDrillForms(card.wordKind, card.formsJson)) {
    throw new CardTypeError(`this word has no forms to drill: ${id}`)
  }

  const owner = findDuplicate(db, { type, answerPl: card.answerPl })
  if (owner !== null && owner !== id) return { card, duplicateOf: owner }

  db.update(cards)
    .set({ type, ...newState(now), updatedAt: now.getTime() })
    .where(eq(cards.id, id))
    .run()
  return { card: db.select().from(cards).where(eq(cards.id, id)).get()!, duplicateOf: null }
}

/**
 * Writes a fresh generation over an existing card, with one collision check:
 * `regenerateCard` is the only caller, repairing a needs_input card. On a
 * clash the card keeps its answer identity (type, answer, kind, forms: on a
 * pl_to_pl card the forms ARE the answer) and still gets the generated
 * prompt, hint, examples and grammar note, which are what it was missing.
 *
 * Writing the generated answer is the point of re-generating at all — it is
 * what restores diacritics a mangled transcript lost. But it also re-keys the
 * card, so when a live card of the same type already owns that key, the new
 * answer is not written and the clash is reported instead: forking the deck
 * into two cards sharing one answer_key is worse than an answer that stays
 * wrong and says so.
 */
export function applyGeneratedFields(
  db: Db,
  card: CardRow,
  fields: GeneratedFields,
  now: Date,
): { card: CardRow; duplicateOf: string | null } {
  // Spec §5: a pl_to_pl card's whole answer is its forms. If this generation
  // left the word with none to drill — a kind without forms, or a kind with
  // forms but no rows — keeping it pl_to_pl would leave a card with no answer
  // at all, so it reverts. The target type also scopes the clash check below.
  // A revert that clashes with a ru_to_pl card for the same word does not
  // happen: on a clash the card keeps its type with its answer and forms, and
  // those forms are drillable — a card only becomes or stays pl_to_pl when
  // they are.
  const type: CardType =
    card.type === 'pl_to_pl' && !canDrillForms(fields.wordKind, fields.formsJson) ? 'ru_to_pl' : card.type
  const owner = findDuplicate(db, { type, answerPl: fields.answerPl })
  const duplicateOf = owner !== null && owner !== card.id ? owner : null
  if (!duplicateOf) return { card: updateCard(db, card.id, { ...fields, type }, now), duplicateOf: null }
  const patch: UpdateCardPatch = {
    promptText: fields.promptText,
    promptHint: fields.promptHint,
    examplePl: fields.examplePl,
    exampleRu: fields.exampleRu,
    grammarNote: fields.grammarNote,
  }
  return { card: updateCard(db, card.id, patch, now), duplicateOf }
}
