import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, reviews } from '../db/schema'
import { createCard, type CreateCardInput } from './service'
import type { Generator } from '../generate'
import { createFormsCard, deleteCard, findDuplicate, searchCards, updateCard } from './service'

const NOW = new Date('2026-09-12T10:00:00')

const input = (over: Partial<CreateCardInput> = {}): CreateCardInput => ({
  type: 'ru_to_pl',
  promptText: 'злобный',
  promptHint: null,
  promptMediaId: null,
  answerPl: 'Złośliwy!',
  examplePl: null,
  exampleRu: null,
  grammarNote: null,
  status: 'ready',
  parentCardId: null,
  ...over,
})

describe('createCard', () => {
  it('creates a card with a normalized answer key and fresh scheduler state', () => {
    const { db } = createTestDb()
    const { cardId, duplicateOf } = createCard(db, input(), NOW)
    expect(duplicateOf).toBeNull()
    const row = db.select().from(cards).get()!
    expect(row.id).toBe(cardId)
    expect(row.answerKey).toBe('złośliwy')
    expect(row.answerPl).toBe('Złośliwy!')
    expect(row.state).toBe(0)
    expect(row.due).toBe(NOW.getTime())
  })

  it('returns the existing card instead of creating a duplicate', () => {
    const { db } = createTestDb()
    const first = createCard(db, input(), NOW)
    const second = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    expect(second).toEqual({ cardId: first.cardId, duplicateOf: first.cardId })
    expect(db.select().from(cards).all()).toHaveLength(1)
  })

  it('treats the same answer under a different card type as a different card', () => {
    const { db } = createTestDb()
    createCard(db, input(), NOW)
    const forms = createCard(db, input({ type: 'pl_forms', promptText: 'złośliwy — formy' }), NOW)
    expect(forms.duplicateOf).toBeNull()
    expect(db.select().from(cards).all()).toHaveLength(2)
  })

  it('still detects a duplicate when the existing card is suspended', () => {
    const { db } = createTestDb()
    const first = createCard(db, input(), NOW)
    db.update(cards).set({ suspendedAt: NOW.getTime() }).where(eq(cards.id, first.cardId)).run()
    // Re-dictating should surface the suspended card, not quietly make a twin.
    expect(createCard(db, input(), NOW).duplicateOf).toBe(first.cardId)
    expect(db.select().from(cards).all()).toHaveLength(1)
  })

  // The following `fallbackAnswerKey` tests are not in the Task 16 brief's
  // verbatim listing. They exist to protect the pipeline extraction (Step 5):
  // lib/capture/pipeline.ts relies on a caller-supplied secondary key so a
  // needs_input card keyed by raw transcript can still be found by a later
  // successful re-dictation keyed by the diacritic-restored answer. Image
  // cards have no transcript and never pass this option.
  describe('fallbackAnswerKey', () => {
    it('is consulted only when the primary answerKey lookup finds nothing', () => {
      const { db } = createTestDb()
      const first = createCard(db, input({ answerPl: 'zloslivy' }), NOW)
      const second = createCard(db, input({ answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }), NOW)
      expect(second).toEqual({ cardId: first.cardId, duplicateOf: first.cardId })
      expect(db.select().from(cards).all()).toHaveLength(1)
    })

    it('lets the primary key win when both the primary AND fallback keys match different existing cards', () => {
      // A test that only ever gives the fallback a key matching nothing can't
      // tell "primary always wins" apart from "whichever query runs last
      // wins" — both implementations pass it, since the fallback never finds
      // anything either way. Seeding a real card under EACH key is the only
      // way to distinguish them: if the implementation queried both and let
      // the later (fallback) query's match win, this would wrongly resolve to
      // `fallbackMatch.cardId` instead of `primaryMatch.cardId`.
      const { db } = createTestDb()
      const primaryMatch = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
      const fallbackMatch = createCard(db, input({ answerPl: 'zloslivy' }), NOW)
      const result = createCard(db, input({ answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }), NOW)
      expect(result).toEqual({ cardId: primaryMatch.cardId, duplicateOf: primaryMatch.cardId })
      expect(result.duplicateOf).not.toBe(fallbackMatch.cardId)
      expect(db.select().from(cards).all()).toHaveLength(2)
    })

    it('creates a fresh card when neither the primary nor the fallback key matches anything', () => {
      const { db } = createTestDb()
      const { duplicateOf } = createCard(db, input({ answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }), NOW)
      expect(duplicateOf).toBeNull()
      expect(db.select().from(cards).all()).toHaveLength(1)
    })

    it('scopes the fallback lookup by type, like the primary lookup', () => {
      const { db } = createTestDb()
      const forms = createCard(db, input({ type: 'pl_forms', answerPl: 'zloslivy' }), NOW)
      const ruToPl = createCard(
        db,
        input({ type: 'ru_to_pl', answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }),
        NOW,
      )
      expect(ruToPl.duplicateOf).toBeNull()
      expect(ruToPl.cardId).not.toBe(forms.cardId)
      expect(db.select().from(cards).all()).toHaveLength(2)
    })
  })
})

describe('searchCards', () => {
  it('matches on the Polish answer and on the Russian prompt', () => {
    const { db } = createTestDb()
    createCard(db, input({ answerPl: 'złośliwy', promptText: 'злобный' }), NOW)
    createCard(db, input({ answerPl: 'przebiegły', promptText: 'хитрый' }), NOW)
    expect(searchCards(db, 'złoś').map((c) => c.answerPl)).toEqual(['złośliwy'])
    expect(searchCards(db, 'хитр').map((c) => c.answerPl)).toEqual(['przebiegły'])
  })

  it('ignores case and returns everything for an empty query', () => {
    const { db } = createTestDb()
    createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    expect(searchCards(db, 'ZŁOŚ')).toHaveLength(1)
    expect(searchCards(db, '')).toHaveLength(1)
  })

  // Soft delete (decided 2026-09-16): a deleted card must vanish from every
  // listing query, not just the review queue — this is the browse screen's
  // only source of truth for what "vanish" means in practice.
  it('excludes a soft-deleted card, both by query and on the empty-query listing', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    deleteCard(db, cardId, NOW)
    expect(searchCards(db, 'złoś')).toHaveLength(0)
    expect(searchCards(db, '')).toHaveLength(0)
  })

  // Minor review finding: SQLite's built-in `lower()`/LIKE fold ASCII only —
  // 'Хитрый' LIKE '%хитр%' is 0 in real SQLite — so a capitalized Russian
  // prompt (the primary prompt language) was unfindable by a lowercase query.
  // The existing "ignores case" test above can't catch this: its fixture is
  // already lowercase Polish (and Polish's Ł/ł DOES fold correctly even in
  // ASCII-only LIKE, since SQLite's lower() happens to handle Latin-1
  // supplement letters — Cyrillic is the gap).
  it('finds a capitalized Russian prompt by a lowercase query', () => {
    const { db } = createTestDb()
    createCard(db, input({ answerPl: 'przebiegły', promptText: 'Хитрый' }), NOW)
    expect(searchCards(db, 'хитр').map((c) => c.answerPl)).toEqual(['przebiegły'])
  })
})

describe('updateCard', () => {
  it('recomputes the answer key when the answer is edited', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ answerPl: 'zloslivy' }), NOW)
    const row = updateCard(db, cardId, { answerPl: 'złośliwy' }, NOW)
    expect(row.answerPl).toBe('złośliwy')
    expect(row.answerKey).toBe('złośliwy')
  })

  it('promotes a needs_input card to ready once it has a prompt', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ status: 'needs_input', promptText: null }), NOW)
    expect(updateCard(db, cardId, { promptText: 'злобный' }, NOW).status).toBe('ready')
  })

  it('will not promote a card that still has no prompt', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input({ status: 'needs_input', promptText: null }), NOW)
    expect(updateCard(db, cardId, { grammarNote: 'что-то' }, NOW).status).toBe('needs_input')
  })

  it('suspends and unsuspends', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    expect(updateCard(db, cardId, { suspendedAt: NOW.getTime() }, NOW).suspendedAt).toBe(NOW.getTime())
    expect(updateCard(db, cardId, { suspendedAt: null }, NOW).suspendedAt).toBeNull()
  })

  it('leaves the scheduler state untouched', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    const before = db.select().from(cards).where(eq(cards.id, cardId)).get()!
    const after = updateCard(db, cardId, { answerPl: 'inny' }, new Date(NOW.getTime() + 1000))
    expect(after.due).toBe(before.due)
    expect(after.reps).toBe(before.reps)
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
  })

  it('throws on an unknown card', () => {
    const { db } = createTestDb()
    expect(() => updateCard(db, 'ghost', { answerPl: 'x' }, NOW)).toThrow(/ghost/)
  })

  // Important review finding: this was the one card-select in the file left
  // without the deleted_at filter. Without it, PATCH /api/cards/<deleted id>
  // returned 200 and silently wrote fields — including the needs_input →
  // ready promotion — to an invisible row, instead of behaving like every
  // other lookup here and treating a soft-deleted card as gone.
  it('throws on a soft-deleted card, the same as an unknown one', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    deleteCard(db, cardId, NOW)
    expect(() => updateCard(db, cardId, { answerPl: 'x' }, NOW)).toThrow(new RegExp(cardId))
  })
})

// Soft delete (decided 2026-09-16): DELETE /api/cards/:id must set `deleted_at`
// rather than remove the row, so `reviews` — the append-only log §7 depends on
// to optimize FSRS parameters and to let a scheduler bug be recovered from by
// replay — survives a delete. This deviates from an earlier version of this
// spec section (and this task's own brief) that had `deleteCard` hard-delete
// the row and cascade its reviews; that was superseded by the decision note at
// the top of this task, which takes precedence.
describe('deleteCard', () => {
  it('soft-deletes: sets deleted_at but keeps the card row and its review history intact', () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    db.insert(reviews)
      .values({ cardId, rating: 3, reviewedAt: NOW.getTime(), durationMs: null, stateBefore: '{}', undoneAt: null })
      .run()
    deleteCard(db, cardId, NOW)
    const row = db.select().from(cards).where(eq(cards.id, cardId)).get()
    expect(row).not.toBeNull()
    expect(row!.deletedAt).toBe(NOW.getTime())
    expect(db.select().from(reviews).all()).toHaveLength(1)
  })

  it('is a silent no-op on an unknown id, like any other idempotent DELETE', () => {
    const { db } = createTestDb()
    expect(() => deleteCard(db, 'ghost', NOW)).not.toThrow()
  })

  // Important review finding: deleting a word must also retire its pl_forms
  // conjugation/declension drill — otherwise you delete a word and keep being
  // drilled on it, which feels identical to a deleted card reappearing.
  // createFormsCard already treats parent_card_id as authoritative in the
  // other direction (idempotent lookup by parent); deleteCard must honor the
  // same link.
  it('cascades to the pl_forms child it owns', async () => {
    const { db } = createTestDb()
    const generator = {
      forms: vi.fn().mockResolvedValue({ prompt_pl: 'przyzwyczaić się — formy', answer_pl: '| … |' }),
    } as unknown as Generator
    const parent = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    const child = await createFormsCard(db, generator, parent.cardId, NOW)

    deleteCard(db, parent.cardId, NOW)

    const parentRow = db.select().from(cards).where(eq(cards.id, parent.cardId)).get()!
    const childRow = db.select().from(cards).where(eq(cards.id, child.cardId)).get()!
    expect(parentRow.deletedAt).toBe(NOW.getTime())
    expect(childRow.deletedAt).toBe(NOW.getTime())
  })

  it('does not delete an unrelated card that merely shares no parent link', () => {
    const { db } = createTestDb()
    const a = createCard(db, input({ answerPl: 'jeden' }), NOW)
    const b = createCard(db, input({ answerPl: 'dwa' }), NOW)
    deleteCard(db, a.cardId, NOW)
    expect(db.select().from(cards).where(eq(cards.id, b.cardId)).get()!.deletedAt).toBeNull()
  })
})

// Decision required by the task brief: "should a soft-deleted card still
// absorb a duplicate?" Chosen NO — a soft-deleted card must not be
// findable by dedup, because if it were, re-dictating a word you just
// deleted would silently resolve to the invisible deleted card instead of
// creating a fresh, visible one. The user would have no way to tell why
// their re-dictation produced nothing new.
describe('findDuplicate and soft delete', () => {
  it('does not match a soft-deleted card', () => {
    const { db } = createTestDb()
    const first = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    deleteCard(db, first.cardId, NOW)
    expect(findDuplicate(db, { type: 'ru_to_pl', answerPl: 'złośliwy' })).toBeNull()
  })

  it('creates a fresh, visible card when re-dictating a word whose only match was deleted', () => {
    const { db } = createTestDb()
    const first = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    deleteCard(db, first.cardId, NOW)
    const second = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
    expect(second.duplicateOf).toBeNull()
    expect(second.cardId).not.toBe(first.cardId)
    expect(searchCards(db, 'złoś').map((c) => c.id)).toEqual([second.cardId])
  })

  // Minor review finding: the single test below only ever asserted
  // `toBeNull()`, which would pass identically if the fallback lookup were
  // removed from findDuplicate entirely — it can't tell "fallback correctly
  // skipped a deleted match" apart from "fallback never ran at all". Split
  // into two: one proves the fallback path is still live by giving it a
  // real, non-deleted match to find; the other keeps the original assertion
  // that a deleted match under the fallback key is skipped.
  it('still finds a live card via the fallback key when the primary lookup finds nothing', () => {
    const { db } = createTestDb()
    const first = createCard(db, input({ answerPl: 'zloslivy' }), NOW)
    // Primary lookup is on answerKey('złośliwy'), which matches nothing;
    // the fallback key 'zloslivy' is what actually finds `first`.
    expect(
      findDuplicate(db, { type: 'ru_to_pl', answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }),
    ).toBe(first.cardId)
  })

  it('skips a fallback match when that card has been soft-deleted', () => {
    const { db } = createTestDb()
    const first = createCard(db, input({ answerPl: 'zloslivy' }), NOW)
    deleteCard(db, first.cardId, NOW)
    // fallbackAnswerKey matches the deleted card only; primary matches nothing.
    expect(
      findDuplicate(db, { type: 'ru_to_pl', answerPl: 'złośliwy', fallbackAnswerKey: 'zloslivy' }),
    ).toBeNull()
  })
})

describe('createFormsCard', () => {
  const generator = {
    forms: vi.fn().mockResolvedValue({ prompt_pl: 'przyzwyczaić się — formy', answer_pl: '| … |' }),
  } as unknown as Generator

  it('creates a pl_forms child linked to its parent', async () => {
    const { db } = createTestDb()
    const parent = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    const child = await createFormsCard(db, generator, parent.cardId, NOW)
    const row = db.select().from(cards).where(eq(cards.id, child.cardId)).get()!
    expect(row.type).toBe('pl_forms')
    expect(row.parentCardId).toBe(parent.cardId)
    expect(row.promptText).toBe('przyzwyczaić się — formy')
    expect(row.answerPl).toBe('| … |')
  })

  it('is idempotent — asking twice does not make two drills', async () => {
    const { db } = createTestDb()
    const parent = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    const first = await createFormsCard(db, generator, parent.cardId, NOW)
    const second = await createFormsCard(db, generator, parent.cardId, NOW)
    expect(second.cardId).toBe(first.cardId)
    expect(db.select().from(cards).all()).toHaveLength(2)
  })

  it('throws on an unknown parent', async () => {
    const { db } = createTestDb()
    await expect(createFormsCard(db, generator, 'ghost', NOW)).rejects.toThrow(/ghost/)
  })

  it('throws on a soft-deleted parent, same as an unknown one', async () => {
    const { db } = createTestDb()
    const parent = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    deleteCard(db, parent.cardId, NOW)
    await expect(createFormsCard(db, generator, parent.cardId, NOW)).rejects.toThrow(/no such card/)
  })

  it('generates a fresh child once the previous forms child was soft-deleted', async () => {
    const { db } = createTestDb()
    const parent = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    const first = await createFormsCard(db, generator, parent.cardId, NOW)
    deleteCard(db, first.cardId, NOW)
    const second = await createFormsCard(db, generator, parent.cardId, NOW)
    expect(second.cardId).not.toBe(first.cardId)
    expect(second.duplicateOf).toBeNull()
  })

  // Important review finding: nothing stopped a pl_forms card from being
  // used as the *parent* of another forms request — one tap would send a
  // whole Markdown table to generator.forms() as a "lemma", burning a model
  // call and inserting a nonsense grandchild. Rejected here, not just hidden
  // in the UI, because the route is reachable directly (e.g. by curl).
  it('refuses to generate forms for a pl_forms parent', async () => {
    const { db } = createTestDb()
    const word = createCard(db, input({ answerPl: 'przyzwyczaić się' }), NOW)
    const forms = await createFormsCard(db, generator, word.cardId, NOW)
    await expect(createFormsCard(db, generator, forms.cardId, NOW)).rejects.toThrow(/pl_forms/)
    expect(generator.forms).not.toHaveBeenCalledWith('| … |')
  })
})
