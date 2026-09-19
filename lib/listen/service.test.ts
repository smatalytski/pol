import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cardAudio, cards, listens, media, reviews, topics } from '../db/schema'
import { createCard, deleteCard, type CreateCardInput } from '../cards/service'
import { setSetting, getSettings } from '../settings'
import { audioKey, estimateMs, sequenceFor, settingsToSequence } from '../audio/sequence'
import { eligibleCard, listenCardOf, markHeard, planSession } from './service'

const NOW = new Date('2026-09-12T10:00:00')

type DbT = ReturnType<typeof createTestDb>['db']

function mkCard(db: DbT, over: Partial<CreateCardInput> = {}): string {
  const { cardId } = createCard(
    db,
    {
      type: 'ru_to_pl',
      promptText: 'слово',
      promptHint: null,
      answerPl: 'słowo',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      wordKind: null,
      formsJson: null,
      status: 'ready',
      ...over,
    },
    NOW,
  )
  return cardId
}

function setDue(db: DbT, cardId: string, due: number) {
  db.update(cards).set({ due }).where(eq(cards.id, cardId)).run()
}

function insertTopic(db: DbT, id: string, suspendedAt: number | null) {
  db.insert(topics).values({ id, name: id, context: 'x', suspendedAt, createdAt: 1, isDefault: false }).run()
}

describe('eligibility', () => {
  it('excludes a pl_to_pl card, a needs_input card, a suspended card, a deleted card, and a switched-off topic card', () => {
    const { db } = createTestDb()
    mkCard(db, { type: 'pl_to_pl', answerPl: 'aaa' })
    mkCard(db, { status: 'needs_input', answerPl: 'bbb', promptText: null })

    const susp = mkCard(db, { answerPl: 'ccc' })
    db.update(cards).set({ suspendedAt: NOW.getTime() }).where(eq(cards.id, susp)).run()

    const del = mkCard(db, { answerPl: 'ddd' })
    deleteCard(db, del, NOW)

    insertTopic(db, 't-off', NOW.getTime())
    mkCard(db, { answerPl: 'eee', topicId: 't-off' })

    expect(planSession(db, { minutes: 10 }, NOW)).toEqual([])
  })

  it('excludes a card with a blank prompt text', () => {
    const { db } = createTestDb()
    mkCard(db, { answerPl: 'fff', promptText: '   ' })
    expect(planSession(db, { minutes: 10 }, NOW)).toEqual([])
  })
})

describe('ordering', () => {
  it('orders due-today cards first (least recently heard first), then the rest (never heard first, then least recently heard)', () => {
    const { db } = createTestDb()
    const dueToday = NOW.getTime()
    const notDue = NOW.getTime() + 5 * 86_400_000

    const a = mkCard(db, { answerPl: 'a-word' })
    setDue(db, a, dueToday)
    const b = mkCard(db, { answerPl: 'b-word' })
    setDue(db, b, dueToday)
    const c = mkCard(db, { answerPl: 'c-word' })
    setDue(db, c, notDue)
    const d = mkCard(db, { answerPl: 'd-word' })
    setDue(db, d, notDue)
    const e = mkCard(db, { answerPl: 'e-word' })
    setDue(db, e, notDue)

    db.insert(listens).values({ cardId: a, heardAt: NOW.getTime() - 86_400_000 }).run() // yesterday
    db.insert(listens).values({ cardId: d, heardAt: NOW.getTime() - 7 * 86_400_000 }).run() // a week ago
    db.insert(listens).values({ cardId: e, heardAt: NOW.getTime() - 86_400_000 }).run() // yesterday

    const result = planSession(db, { minutes: 45 }, NOW)
    expect(result.map((c) => c.id)).toEqual([b, a, c, d, e])
  })

  it('breaks a tie on due, then on id', () => {
    const { db } = createTestDb()
    const dueToday = NOW.getTime()
    const x = mkCard(db, { answerPl: 'x-word' })
    const y = mkCard(db, { answerPl: 'y-word' })
    setDue(db, x, dueToday)
    setDue(db, y, dueToday)

    const result = planSession(db, { minutes: 45 }, NOW)
    expect(result.map((c) => c.id)).toEqual([x, y].sort())
  })
})

describe('topic filter', () => {
  it('includes only the given topics, and a switched-off topic among topicIds contributes nothing', () => {
    const { db } = createTestDb()
    insertTopic(db, 't-on', null)
    insertTopic(db, 't-off', NOW.getTime())
    const inTopic = mkCard(db, { answerPl: 'in-topic', topicId: 't-on' })
    mkCard(db, { answerPl: 'off-topic', topicId: 't-off' })
    mkCard(db, { answerPl: 'no-topic' })

    const result = planSession(db, { minutes: 45, topicIds: ['t-on', 't-off'] }, NOW)
    expect(result.map((c) => c.id)).toEqual([inTopic])
  })
})

describe('excludeIds', () => {
  it('removes those cards', () => {
    const { db } = createTestDb()
    const a = mkCard(db, { answerPl: 'exc-a' })
    const b = mkCard(db, { answerPl: 'exc-b' })

    const result = planSession(db, { minutes: 45, excludeIds: [a] }, NOW)
    expect(result.map((c) => c.id)).toEqual([b])
  })
})

describe('time budget', () => {
  it('stops at the first card that reaches or passes the budget, inclusive', () => {
    const { db } = createTestDb()
    setSetting(db, 'audioGapSeconds', '0')
    setSetting(db, 'audioRepeatAnswer', '0')
    setSetting(db, 'audioExample', '0')

    // ruLen (299) + answerLen (1), times 60ms, plus 2000ms trailing silence = 20000ms.
    const promptText = 'a'.repeat(299)
    for (const answerPl of ['b', 'c', 'd', 'e']) {
      mkCard(db, { answerPl, promptText })
    }

    const result = planSession(db, { minutes: 1 }, NOW)
    expect(result).toHaveLength(3)
    expect(result.every((c) => c.estimatedMs === 20_000)).toBe(true)
    expect(result.reduce((sum, c) => sum + c.estimatedMs, 0)).toBe(60_000)
  })

  it("uses a cached card_audio row's duration instead of the estimate for the card's current key", () => {
    const { db } = createTestDb()
    const id = mkCard(db, { answerPl: 'cache-word' })
    const card = db.select().from(cards).where(eq(cards.id, id)).get()!
    const listenCard = listenCardOf(card)
    const settings = settingsToSequence(getSettings(db))
    const naturalEstimate = estimateMs(sequenceFor(listenCard, settings))
    const key = audioKey(listenCard, settings)

    db.insert(media).values({ id: 'm1', kind: 'listen', mime: 'audio/mpeg', bytes: Buffer.from([1]), byteSize: 1, createdAt: NOW.getTime() }).run()
    db.insert(cardAudio).values({ key, mediaId: 'm1', durationMs: naturalEstimate + 12_345, createdAt: NOW.getTime() }).run()

    const [planned] = planSession(db, { minutes: 45 }, NOW)
    expect(planned.estimatedMs).toBe(naturalEstimate + 12_345)
  })
})

describe('markHeard', () => {
  it('inserts a listens row and leaves the review schedule untouched', () => {
    const { db } = createTestDb()
    const id = mkCard(db, { answerPl: 'heard-word' })
    const before = db.select().from(cards).where(eq(cards.id, id)).get()!

    const ok = markHeard(db, id, NOW)

    expect(ok).toBe(true)
    const rows = db.select().from(listens).where(eq(listens.cardId, id)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].heardAt).toBe(NOW.getTime())

    const after = db.select().from(cards).where(eq(cards.id, id)).get()!
    expect(after.due).toBe(before.due)
    expect(after.reps).toBe(before.reps)
    expect(after.state).toBe(before.state)
    expect(db.select().from(reviews).all()).toEqual([])
  })

  it('returns false for an unknown card', () => {
    const { db } = createTestDb()
    expect(markHeard(db, 'nonexistent-id', NOW)).toBe(false)
  })
})

describe('eligibleCard', () => {
  it('returns the card row when it is eligible', () => {
    const { db } = createTestDb()
    const id = mkCard(db, { answerPl: 'elig-word' })
    expect(eligibleCard(db, id)?.id).toBe(id)
  })

  it('returns null for an ineligible or unknown card', () => {
    const { db } = createTestDb()
    const susp = mkCard(db, { answerPl: 'susp-word' })
    db.update(cards).set({ suspendedAt: NOW.getTime() }).where(eq(cards.id, susp)).run()
    expect(eligibleCard(db, susp)).toBeNull()
    expect(eligibleCard(db, 'nope')).toBeNull()
  })
})

describe('listenCardOf', () => {
  it('maps a card row to a ListenCard', () => {
    const { db } = createTestDb()
    const id = mkCard(db, { answerPl: 'map-word', promptHint: 'hint', examplePl: 'example' })
    const card = db.select().from(cards).where(eq(cards.id, id)).get()!
    expect(listenCardOf(card)).toEqual({
      promptText: 'слово',
      promptHint: 'hint',
      answerPl: 'map-word',
      examplePl: 'example',
    })
  })
})
