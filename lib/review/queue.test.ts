import { describe, expect, it } from 'vitest'
import { createTestDb } from '../db/testing'
import { cards, reviews } from '../db/schema'
import { newState } from '../scheduler'
import { buildQueue, interleave, newCardsIntroducedToday, startOfLocalDay } from './queue'
import { setSetting } from '../settings'

const NOW = new Date('2026-09-12T10:00:00')

function insertCard(
  db: ReturnType<typeof createTestDb>['db'],
  over: Partial<typeof cards.$inferInsert> = {},
) {
  const id = over.id ?? Math.random().toString(36).slice(2)
  const s = newState(NOW)
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
      ...s,
      ...over,
    })
    .run()
  return id
}

describe('interleave', () => {
  it('spaces new cards through the due cards rather than front-loading them', () => {
    expect(interleave([1, 2, 3, 4, 5, 6], ['a', 'b'])).toEqual([1, 2, 3, 'a', 4, 5, 6, 'b'])
  })

  it('returns only the new cards when nothing is due', () => {
    expect(interleave([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns only the due cards when there are no new ones', () => {
    expect(interleave([1, 2], [])).toEqual([1, 2])
  })

  it('spaces what it can and appends the leftovers', () => {
    // stride is 2, so one new card lands mid-session and the rest tail it.
    expect(interleave([1, 2, 3], ['a', 'b', 'c'])).toEqual([1, 2, 'a', 3, 'b', 'c'])
  })

  it('appends leftover new cards at the end', () => {
    expect(interleave([1, 2], ['a', 'b', 'c'])).toEqual([1, 2, 'a', 'b', 'c'])
  })
})

describe('buildQueue', () => {
  it('orders due cards by urgency', async () => {
    const { db } = createTestDb()
    const later = insertCard(db, { id: 'later', due: NOW.getTime() - 1_000, state: 2, reps: 1 })
    const earlier = insertCard(db, { id: 'earlier', due: NOW.getTime() - 90_000, state: 2, reps: 1 })
    const q = await buildQueue(db, NOW)
    expect(q.map((c) => c.id)).toEqual([earlier, later])
  })

  it('excludes cards that are not yet due', async () => {
    const { db } = createTestDb()
    insertCard(db, { id: 'future', due: NOW.getTime() + 86_400_000, state: 2, reps: 1 })
    expect(await buildQueue(db, NOW)).toEqual([])
  })

  it('excludes suspended and needs_input cards', async () => {
    const { db } = createTestDb()
    insertCard(db, { id: 'susp', suspendedAt: NOW.getTime() })
    insertCard(db, { id: 'todo', status: 'needs_input' })
    expect(await buildQueue(db, NOW)).toEqual([])
  })

  // Soft delete (decided 2026-09-16): a deleted card must never be served,
  // in either branch REVIEWABLE feeds — the fresh/new-card branch (state 0,
  // exercised here the same way the suspended/needs_input test above does)
  // and the due branch (state != 0, already due). Regression guard for the
  // authorized REVIEWABLE change in lib/review/queue.ts.
  it('excludes a soft-deleted card from the new-card branch', async () => {
    const { db } = createTestDb()
    insertCard(db, { id: 'gone', deletedAt: NOW.getTime() })
    expect(await buildQueue(db, NOW)).toEqual([])
  })

  it('excludes a soft-deleted card from the due branch', async () => {
    const { db } = createTestDb()
    insertCard(db, { id: 'gone-due', due: NOW.getTime() - 1_000, state: 2, reps: 1, deletedAt: NOW.getTime() })
    expect(await buildQueue(db, NOW)).toEqual([])
  })

  it('caps how many new cards enter the session', async () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', '2')
    for (let i = 0; i < 5; i++) insertCard(db, { id: `n${i}` })
    const q = await buildQueue(db, NOW)
    expect(q.filter((c) => c.isNew)).toHaveLength(2)
  })

  it('counts new cards already introduced earlier today against the cap', async () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', '2')
    for (let i = 0; i < 5; i++) insertCard(db, { id: `n${i}` })
    db.insert(reviews)
      .values({
        cardId: 'n0',
        rating: 3,
        reviewedAt: startOfLocalDay(NOW) + 3_600_000,
        durationMs: null,
        stateBefore: JSON.stringify({ state: 0 }),
        undoneAt: null,
      })
      .run()
    expect(newCardsIntroducedToday(db, NOW)).toBe(1)
    const served = (await buildQueue(db, NOW)).filter((c) => c.isNew)
    expect(served).toHaveLength(1)
    // n0 was already introduced today (its `cards.state` just hasn't caught up
    // to that yet in this test); it must not be re-served as new, and one of
    // the genuinely-unintroduced n1..n4 must fill the slot instead.
    expect(served.map((c) => c.id)).not.toContain('n0')
  })

  it('re-offers a card as new once its earlier introduction today was undone', async () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', '2')
    insertCard(db, { id: 'undone-intro' }) // state stays 0: the review below was undone
    db.insert(reviews)
      .values({
        cardId: 'undone-intro',
        rating: 3,
        reviewedAt: startOfLocalDay(NOW) + 3_600_000,
        durationMs: null,
        stateBefore: JSON.stringify({ state: 0 }),
        undoneAt: NOW.getTime(),
      })
      .run()
    const q = await buildQueue(db, NOW)
    expect(q.filter((c) => c.isNew).map((c) => c.id)).toContain('undone-intro')
  })

  it('does not count yesterday, an undone review, or a non-new review against the cap', async () => {
    const { db } = createTestDb()
    insertCard(db, { id: 'x' }) // reviews.card_id is a real foreign key
    const base = {
      cardId: 'x',
      rating: 3,
      durationMs: null,
      stateBefore: JSON.stringify({ state: 0 }),
      undoneAt: null,
    }
    db.insert(reviews).values([
      { ...base, reviewedAt: startOfLocalDay(NOW) - 1 },
      { ...base, reviewedAt: startOfLocalDay(NOW) + 1, undoneAt: NOW.getTime() },
      { ...base, reviewedAt: startOfLocalDay(NOW) + 2, stateBefore: JSON.stringify({ state: 2 }) },
    ]).run()
    expect(newCardsIntroducedToday(db, NOW)).toBe(0)
  })

  it('still serves a card as new when its only New-state review was yesterday', async () => {
    // Pins the date clause specifically in buildQueue's anti-join (as
    // opposed to newCardsIntroducedToday's count): yesterday's introduction
    // must not count against today, in either place the predicate is
    // evaluated. Without the date clause here, this card would wrongly look
    // "already introduced" forever and never be re-offered.
    const { db } = createTestDb()
    insertCard(db, { id: 'y' }) // state stays 0: never actually introduced today
    db.insert(reviews)
      .values({
        cardId: 'y',
        rating: 3,
        reviewedAt: startOfLocalDay(NOW) - 1,
        durationMs: null,
        stateBefore: JSON.stringify({ state: 0 }),
        undoneAt: null,
      })
      .run()
    const q = await buildQueue(db, NOW)
    expect(q.filter((c) => c.isNew).map((c) => c.id)).toContain('y')
  })
})
