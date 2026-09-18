import { describe, expect, it } from 'vitest'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, reviews, topics } from '../db/schema'
import { newState } from '../scheduler'
import { buildQueue, interleave, newCardsIntroducedToday, REVIEWABLE, startOfLocalDay } from './queue'
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
      answerPl: 'złośliwy',
      answerKey: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      suspendedAt: null,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      ...s,
      ...over,
    })
    .run()
  return id
}

describe('the due query', () => {
  it('uses the cards_due index', () => {
    const { db, sqlite } = createTestDb()
    const q = db
      .select({ id: cards.id })
      .from(cards)
      .where(and(REVIEWABLE, sql`${cards.state} != 0`, lte(cards.due, 0)))
      .orderBy(asc(cards.due))
      .toSQL()
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/cards_due/)
  })
})

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

  // Important review finding: `newCardsIntroducedToday` is a plain
  // `count(distinct reviews.card_id)` with no join back to `cards`, so a
  // card's review still counts toward the daily cap even after the card
  // itself is soft-deleted. Combined with the (correct) `findDuplicate`
  // decision that a soft-deleted card doesn't absorb a re-dictation,
  // delete-then-re-dictate silently consumes TWO of `newPerDay`'s slots for
  // one surviving card, with no visible signal — the only symptom is the
  // day's new material running out early.
  it('does not count a soft-deleted card toward the daily new-card cap', async () => {
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
    db.update(cards).set({ deletedAt: NOW.getTime() }).where(eq(cards.id, 'n0')).run()

    expect(newCardsIntroducedToday(db, NOW)).toBe(0)
    const served = (await buildQueue(db, NOW)).filter((c) => c.isNew)
    expect(served).toHaveLength(2)
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

describe('topics in review', () => {
  function withTopic(db: ReturnType<typeof createTestDb>['db'], suspendedAt: number | null) {
    db.insert(topics).values({ id: 't1', name: 'x', context: 'x', suspendedAt, createdAt: 1 }).run()
  }

  it('leaves out a card whose topic is switched off', async () => {
    const { db } = createTestDb()
    withTopic(db, NOW.getTime())
    insertCard(db, { id: 'a', topicId: 't1' })
    insertCard(db, { id: 'b', answerPl: 'kot', answerKey: 'kot' })
    expect((await buildQueue(db, NOW)).map((c) => c.id)).toEqual(['b'])
  })

  it('serves it again once the topic is switched back on', async () => {
    const { db } = createTestDb()
    withTopic(db, null)
    insertCard(db, { id: 'a', topicId: 't1' })
    expect((await buildQueue(db, NOW)).map((c) => c.id)).toEqual(['a'])
  })

  // The topic switch never writes cards.suspended_at, so a card suspended on
  // its own stays suspended whatever its topic does (spec §3.5).
  it('keeps an individually suspended card out under a topic that is on', async () => {
    const { db } = createTestDb()
    withTopic(db, null)
    insertCard(db, { id: 'a', topicId: 't1', suspendedAt: 1 })
    expect(await buildQueue(db, NOW)).toEqual([])
  })
})

describe('buildQueue forms', () => {
  it('hands each card its forms parsed, ready to render', async () => {
    const { db } = createTestDb()
    const forms = { basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] }
    insertCard(db, { answerPl: 'kot', answerKey: 'kot', wordKind: 'rzeczownik', formsJson: JSON.stringify(forms) })
    const [item] = await buildQueue(db, NOW)
    expect(item.wordKind).toBe('rzeczownik')
    expect(item.forms).toEqual(forms)
  })

  it('gives a card with no stored forms null forms', async () => {
    const { db } = createTestDb()
    insertCard(db, { wordKind: 'fraza', formsJson: null })
    const [item] = await buildQueue(db, NOW)
    expect(item.forms).toBeNull()
  })
})
