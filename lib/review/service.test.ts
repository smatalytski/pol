import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, reviews } from '../db/schema'
import { deleteCard } from '../cards/service'
import { newState, type SchedulerState } from '../scheduler'
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

  // Unnamed invariant, A5: `recordReview` persists scheduler state by
  // spreading a plain object (`set({ ...after })`) into a typed Drizzle
  // `.set()`, which silently ignores any key that isn't a real column
  // property name — and TypeScript's spread doesn't apply excess-property
  // checks, so a renamed or added field (e.g. from a ts-fsrs upgrade) would
  // stop persisting with no error anywhere. This asserts every key of the
  // object `recordReview` actually returns survives a real round trip
  // through the `cards` table, not just that the two objects are `.toEqual`
  // each other in memory.
  it('persists every key of the returned SchedulerState onto the re-read row (drift guard)', () => {
    const { db } = createTestDb()
    const id = seed(db)
    const after = recordReview(db, id, 3, null, NOW)
    const row = db.select().from(cards).where(eq(cards.id, id)).get()!
    for (const key of Object.keys(after) as (keyof SchedulerState)[]) {
      expect(row[key], `column ${key}`).toBe(after[key])
    }
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

  it('throws on a soft-deleted card rather than silently advancing it', () => {
    const { db } = createTestDb()
    const id = seed(db)
    deleteCard(db, id, NOW)
    expect(() => recordReview(db, id, 3, null, NOW)).toThrow(new RegExp(id))
    expect(db.select().from(reviews).all()).toHaveLength(0)
  })

  it('throws on a backwards clock and leaves the database untouched', () => {
    const { db } = createTestDb()
    const id = seed(db)
    const future = new Date(NOW.getTime() + 60_000)
    db.update(cards).set({ lastReview: future.getTime() }).where(eq(cards.id, id)).run()
    const before = db.select().from(cards).where(eq(cards.id, id)).get()!

    expect(() => recordReview(db, id, 3, null, NOW)).toThrow(/is before last review/)
    expect(db.select().from(cards).where(eq(cards.id, id)).get()).toEqual(before)
    expect(db.select().from(reviews).all()).toHaveLength(0)
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

  it('skips a deleted card and undoes the next-most-recent live review instead', () => {
    const { db } = createTestDb()
    const a = seed(db, 'a')
    const b = seed(db, 'b')
    const bBefore = db.select().from(cards).where(eq(cards.id, b)).get()!
    recordReview(db, b, 3, null, NOW)
    recordReview(db, a, 3, null, new Date(NOW.getTime() + 60_000))
    deleteCard(db, a, new Date(NOW.getTime() + 120_000))

    expect(undoLastReview(db, NOW)).toEqual({ cardId: b })
    expect(db.select().from(cards).where(eq(cards.id, b)).get()).toEqual(bBefore)
    // A's own review row is left alone: it belongs to a card the user can no
    // longer see, so it must not be silently marked undone either.
    const aLog = db.select().from(reviews).where(eq(reviews.cardId, a)).get()!
    expect(aLog.undoneAt).toBeNull()
  })

  it('returns null when the only pending review belongs to a deleted card', () => {
    const { db } = createTestDb()
    const id = seed(db)
    recordReview(db, id, 3, null, NOW)
    deleteCard(db, id, NOW)
    expect(undoLastReview(db, NOW)).toBeNull()
  })

  it('throws rather than silently writing partial state when state_before is corrupt', () => {
    const { db } = createTestDb()
    const id = seed(db)
    db.insert(reviews)
      .values({
        cardId: id,
        rating: 3,
        reviewedAt: NOW.getTime(),
        durationMs: null,
        // Short: missing every field but `state`. A newer ts-fsrs adding or
        // renaming a field, or any other shape drift in the replayed log,
        // must fail loudly here rather than spread stale/undefined values
        // into `cards`.
        stateBefore: JSON.stringify({ state: 0 }),
        undoneAt: null,
      })
      .run()
    const before = db.select().from(cards).where(eq(cards.id, id)).get()!
    expect(() => undoLastReview(db, NOW)).toThrow(/invalid scheduler state/)
    expect(db.select().from(cards).where(eq(cards.id, id)).get()).toEqual(before)
  })

  it('undoes the truly-last-inserted review even when a backwards clock makes it not the latest by reviewedAt', () => {
    const { db } = createTestDb()
    const a = seed(db, 'a')
    const b = seed(db, 'b')
    // Card A is reviewed at 10:02...
    recordReview(db, a, 3, null, new Date(NOW.getTime() + 120_000))
    // ...then the clock steps back (e.g. an NTP correction) and card B is
    // reviewed at 10:00, i.e. genuinely after A in insertion order despite
    // having an earlier reviewedAt. The per-card backwards-clock guard in
    // applyRating doesn't fire here because it only compares against B's own
    // prior lastReview (null), not against other cards' reviews.
    recordReview(db, b, 3, null, NOW)
    // The user's most recent action was rating B; undo must revert B, not A.
    expect(undoLastReview(db, NOW)).toEqual({ cardId: b })
  })
})
