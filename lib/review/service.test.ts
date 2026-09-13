import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, reviews } from '../db/schema'
import { newState } from '../scheduler'
import { recordReview, undoLastReview } from './service'

const NOW = new Date('2026-09-12T10:00:00')

function seed(db: ReturnType<typeof createTestDb>['db'], id = 'c1') {
  db.insert(cards)
    .values({
      id,
      type: 'ru_to_pl',
      promptText: 'злобный',
      promptHint: null,
      promptMediaId: null,
      answerPl: 'złośliwy',
      answerKey: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      parentCardId: null,
      suspendedAt: null,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      ...newState(NOW),
    })
    .run()
  return id
}

describe('recordReview', () => {
  it('advances the card and returns its new state', () => {
    const { db } = createTestDb()
    const id = seed(db)
    const next = recordReview(db, id, 3, 4200, NOW)
    const row = db.select().from(cards).where(eq(cards.id, id)).get()!
    expect(row.reps).toBe(1)
    expect(row.due).toBe(next.due)
    expect(row.due).toBeGreaterThan(NOW.getTime())
  })

  it('appends a log row carrying the PRE-review state', () => {
    const { db } = createTestDb()
    const id = seed(db)
    recordReview(db, id, 3, 4200, NOW)
    const log = db.select().from(reviews).all()
    expect(log).toHaveLength(1)
    expect(log[0].rating).toBe(3)
    expect(log[0].durationMs).toBe(4200)
    expect(JSON.parse(log[0].stateBefore).state).toBe(0)
    expect(JSON.parse(log[0].stateBefore).reps).toBe(0)
  })

  it('throws on an unknown card rather than silently logging', () => {
    const { db } = createTestDb()
    expect(() => recordReview(db, 'ghost', 3, null, NOW)).toThrow(/ghost/)
  })
})

describe('undoLastReview', () => {
  it('restores the card byte-for-byte', () => {
    const { db } = createTestDb()
    const id = seed(db)
    const before = db.select().from(cards).where(eq(cards.id, id)).get()!
    recordReview(db, id, 4, null, NOW)
    expect(undoLastReview(db, NOW)).toEqual({ cardId: id })
    expect(db.select().from(cards).where(eq(cards.id, id)).get()).toEqual(before)
  })

  it('marks the log row undone instead of deleting it', () => {
    const { db } = createTestDb()
    const id = seed(db)
    recordReview(db, id, 4, null, NOW)
    undoLastReview(db, NOW)
    const log = db.select().from(reviews).all()
    expect(log).toHaveLength(1)
    expect(log[0].undoneAt).toBe(NOW.getTime())
  })

  it('undoes only the most recent review, and only once', () => {
    const { db } = createTestDb()
    const id = seed(db)
    recordReview(db, id, 3, null, NOW)
    const mid = db.select().from(cards).where(eq(cards.id, id)).get()!
    recordReview(db, id, 3, null, new Date(NOW.getTime() + 60_000))
    undoLastReview(db, NOW)
    expect(db.select().from(cards).where(eq(cards.id, id)).get()).toEqual(mid)
    expect(undoLastReview(db, NOW)).toEqual({ cardId: id })
    expect(undoLastReview(db, NOW)).toBeNull()
  })

  it('returns null when there is nothing to undo', () => {
    const { db } = createTestDb()
    expect(undoLastReview(db, NOW)).toBeNull()
  })
})
