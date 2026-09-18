import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, reviews } from '../db/schema'
import { createCard, type CreateCardInput } from './service'
import type { Generator, GeneratedCard } from '../generate'
import { deleteCard, findDuplicate, regenerateCard, searchCards, updateCard } from './service'

const NOW = new Date('2026-09-12T10:00:00')

const input = (over: Partial<CreateCardInput> = {}): CreateCardInput => ({
  type: 'ru_to_pl',
  promptText: 'злобный',
  promptHint: null,
  answerPl: 'Złośliwy!',
  examplePl: null,
  exampleRu: null,
  grammarNote: null,
  status: 'ready',
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
    const forms = createCard(db, input({ type: 'pl_to_pl', promptText: 'złośliwy — formy' }), NOW)
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
      const forms = createCard(db, input({ type: 'pl_to_pl', answerPl: 'zloslivy' }), NOW)
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

describe('regenerateCard', () => {
  // What a successful generation looks like: the model restores diacritics and
  // drops the dictation's sentence punctuation, which is why `answer_pl` here
  // differs from the transcript the card was stranded with.
  const generated: GeneratedCard = {
    prompt_ru: '\u0437\u0434\u043e\u0440\u043e\u0432 \u043a\u0430\u043a \u0431\u044b\u043a',
    prompt_hint: '\u0438\u0434\u0438\u043e\u043c\u0430',
    answer_pl: 'zdr\u00f3w jak ryba',
    example_pl: 'Czuj\u0119 si\u0119 zdr\u00f3w jak ryba.',
    example_ru: '\u0427\u0443\u0432\u0441\u0442\u0432\u0443\u044e \u0441\u0435\u0431\u044f \u0437\u0434\u043e\u0440\u043e\u0432\u044b\u043c.',
    grammar_note: '\u043a\u0440\u0430\u0442\u043a\u0430\u044f \u0444\u043e\u0440\u043c\u0430',
    kind: 'fraza',
    forms_basic: [],
    forms_extended: [],
  }
  const gen = () => ({ fromDictation: vi.fn().mockResolvedValue(generated) }) as unknown as Generator

  const stranded = (over: Partial<CreateCardInput> = {}) =>
    input({ status: 'needs_input', promptText: null, answerPl: 'Zdr\u00f3w jak ryba.', ...over })

  it('regenerates from the stored transcript and promotes the card to ready', async () => {
    const { db } = createTestDb()
    const generator = gen()
    const { cardId } = createCard(db, stranded(), NOW)
    const { card } = await regenerateCard(db, generator, cardId, NOW)
    expect(generator.fromDictation).toHaveBeenCalledWith('Zdr\u00f3w jak ryba.')
    expect(card.status).toBe('ready')
    expect(card.promptText).toBe(generated.prompt_ru)
    expect(card.promptHint).toBe(generated.prompt_hint)
    expect(card.examplePl).toBe(generated.example_pl)
    expect(card.exampleRu).toBe(generated.example_ru)
    expect(card.grammarNote).toBe(generated.grammar_note)
  })

  // The point of writing the normalized answer at all: a transcript that lost
  // its diacritics leaves a misspelled answer that only regeneration can fix.
  it('writes the normalized answer and re-keys the card', async () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, stranded({ answerPl: 'Zdrow jak ryba.' }), NOW)
    const { card, duplicateOf } = await regenerateCard(db, gen(), cardId, NOW)
    expect(duplicateOf).toBeNull()
    expect(card.answerPl).toBe('zdr\u00f3w jak ryba')
    expect(card.answerKey).toBe('zdr\u00f3w jak ryba')
  })

  // A live card of the same type already owns the regenerated key. Rewriting
  // the answer would fork the deck into two cards with one key, so the answer
  // stays put and the caller is told which card it clashed with — the prompt
  // and examples are still worth having.
  it('keeps the original answer when the regenerated one collides with a live card', async () => {
    const { db } = createTestDb()
    const existing = createCard(db, input({ answerPl: 'zdr\u00f3w jak ryba' }), NOW)
    const { cardId } = createCard(db, stranded({ answerPl: 'Zdrow jak ryba.' }), NOW)
    const { card, duplicateOf } = await regenerateCard(db, gen(), cardId, NOW)
    expect(duplicateOf).toBe(existing.cardId)
    expect(card.answerPl).toBe('Zdrow jak ryba.')
    expect(card.answerKey).toBe('zdrow jak ryba')
    expect(card.promptText).toBe(generated.prompt_ru)
    expect(card.status).toBe('ready')
  })

  it('refuses a card that is not needs_input', async () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, input(), NOW)
    await expect(regenerateCard(db, gen(), cardId, NOW)).rejects.toThrow(/needs_input/)
  })

  it('refuses a soft-deleted card', async () => {
    const { db } = createTestDb()
    const { cardId } = createCard(db, stranded(), NOW)
    deleteCard(db, cardId, NOW)
    await expect(regenerateCard(db, gen(), cardId, NOW)).rejects.toThrow(/no such card/)
  })
})
