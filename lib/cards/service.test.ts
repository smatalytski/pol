import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards } from '../db/schema'
import { createCard, type CreateCardInput } from './service'

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

    it('does not consult the fallback when the primary key already matched', () => {
      const { db } = createTestDb()
      const first = createCard(db, input({ answerPl: 'złośliwy' }), NOW)
      // A fallback key that (if consulted) would point at nothing sensible —
      // proves the primary match short-circuits before the fallback is even read.
      const second = createCard(
        db,
        input({ answerPl: 'złośliwy', fallbackAnswerKey: 'this-key-matches-no-card' }),
        NOW,
      )
      expect(second).toEqual({ cardId: first.cardId, duplicateOf: first.cardId })
      expect(db.select().from(cards).all()).toHaveLength(1)
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
