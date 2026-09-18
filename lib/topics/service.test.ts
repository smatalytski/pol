import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { captures, cards, generationJobs, suggestions, topics } from '../db/schema'
import { createCard, deleteCard } from '../cards/service'
import type { Suggestion, Suggester } from '../generate'
import { enqueueJob } from '../queue/jobs'
import {
  acceptRound,
  activeSuggestJob,
  createTopic,
  enqueueSuggest,
  latestRound,
  listTopics,
  parseRoundJob,
  retrySuggest,
  runSuggest,
  topicView,
  updateTopic,
} from './service'

type Db = ReturnType<typeof createTestDb>['db']
const NOW = new Date('2026-09-18T10:00:00')

function topic(db: Db, id = 't1', over: Partial<typeof topics.$inferInsert> = {}) {
  db.insert(topics).values({ id, name: null, context: 'u lekarza z dzieckiem, grypa', suspendedAt: null, createdAt: NOW.getTime(), ...over }).run()
  return id
}

function suggestion(db: Db, answerPl: string, over: Partial<typeof suggestions.$inferInsert> = {}) {
  const id = over.id ?? `s-${answerPl}`
  db.insert(suggestions).values({
    id, topicId: 't1', round: 1, answerPl, glossRu: 'перевод', kind: 'slowo', status: 'proposed',
    captureId: null, createdAt: NOW.getTime(), ...over,
  }).run()
  return id
}

function card(db: Db, answerPl: string, over: { type?: 'ru_to_pl' | 'pl_to_pl' } = {}) {
  return createCard(db, {
    type: over.type ?? 'ru_to_pl', promptText: 'x', promptHint: null, answerPl, examplePl: null, exampleRu: null,
    grammarNote: null, wordKind: null, formsJson: null, status: 'ready',
  }, NOW).cardId
}

const jobRow = (db: Db, id: string) => db.select().from(generationJobs).where(eq(generationJobs.id, id)).get()!

function suggester(items: Suggestion['items'], topic_name = 'U lekarza z dzieckiem') {
  const suggest = vi.fn().mockResolvedValue({ topic_name, items } satisfies Suggestion)
  return { suggest } satisfies Suggester
}

const it_ = (answer_pl: string, kind: 'slowo' | 'fraza' = 'slowo') => ({ answer_pl, gloss_ru: `ru:${answer_pl}`, kind })

describe('enqueueSuggest', () => {
  it('queues round 1 for a new topic', () => {
    const { db } = createTestDb()
    topic(db)
    const id = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)!
    expect(jobRow(db, id)).toMatchObject({ kind: 'suggest', topicId: 't1', status: 'queued' })
    expect(parseRoundJob(jobRow(db, id).paramsJson)).toEqual({ round: 1, count: 10, mix: 'mieszane' })
  })

  it('queues the round after the highest one that exists', () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { round: 2 })
    expect(latestRound(db, 't1')).toBe(2)
    const id = enqueueSuggest(db, 't1', { count: 5, mix: 'frazy' }, NOW)!
    expect(parseRoundJob(jobRow(db, id).paramsJson).round).toBe(3)
  })

  it('refuses a second round while one is queued or running', () => {
    const { db } = createTestDb()
    topic(db)
    const first = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)!
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'running' }).where(eq(generationJobs.id, first)).run()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).where(eq(generationJobs.id, first)).run()
    expect(activeSuggestJob(db, 't1')).toBeUndefined()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane' }, NOW)).not.toBeNull()
  })
})

describe('runSuggest', () => {
  function queued(db: Db, count = 10, mix: 'mieszane' | 'slowa' | 'frazy' = 'mieszane') {
    return jobRow(db, enqueueSuggest(db, 't1', { count, mix }, NOW)!)
  }

  it('asks for count × 1.5 split by the mix, excluding the topic history', async () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { status: 'rejected' })
    suggestion(db, 'kaszel', { status: 'accepted' })
    const s = suggester([])
    await runSuggest({ db, suggester: s }, queued(db, 10, 'slowa'), NOW)
    expect(s.suggest).toHaveBeenCalledWith({
      context: 'u lekarza z dzieckiem, grypa', count: 15, words: 12, phrases: 3, exclude: ['katar', 'kaszel'],
    })
  })

  it('stores the round as proposed, dropping deck words, history and repeats, trimmed to count', async () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { status: 'rejected' })
    card(db, 'gorączka')
    const s = suggester([it_('Gorączka'), it_('katar'), it_('osłuchać'), it_('osłuchać'), it_('L4'), it_('recepta')])
    await runSuggest({ db, suggester: s }, queued(db, 2), NOW)
    const round2 = db.select().from(suggestions).where(eq(suggestions.round, 2)).all()
    expect(round2.map((r) => [r.answerPl, r.glossRu, r.status])).toEqual([
      ['osłuchać', 'ru:osłuchać', 'proposed'],
      ['L4', 'ru:L4', 'proposed'],
    ])
  })

  it('ignores deleted cards and forms-only cards when checking the deck', async () => {
    const { db } = createTestDb()
    topic(db)
    deleteCard(db, card(db, 'gorączka'), NOW)
    card(db, 'katar', { type: 'pl_to_pl' })
    await runSuggest({ db, suggester: suggester([it_('gorączka'), it_('katar')]) }, queued(db), NOW)
    expect(db.select().from(suggestions).all()).toHaveLength(2)
  })

  it('names an unnamed topic, and leaves a named one alone', async () => {
    const { db } = createTestDb()
    topic(db)
    await runSuggest({ db, suggester: suggester([it_('a')], 'U lekarza') }, queued(db), NOW)
    expect(db.select().from(topics).get()!.name).toBe('U lekarza')
    db.update(generationJobs).set({ status: 'done' }).run()
    await runSuggest({ db, suggester: suggester([it_('b')], 'Inna nazwa') }, queued(db), NOW)
    expect(db.select().from(topics).get()!.name).toBe('U lekarza')
  })

  // The process died after inserting the round but before the job was marked
  // done; the job runs again and must not produce a second copy.
  it('does nothing when its round already exists', async () => {
    const { db } = createTestDb()
    topic(db)
    const job = queued(db)
    suggestion(db, 'katar', { round: 1 })
    const s = suggester([it_('osłuchać')])
    await runSuggest({ db, suggester: s }, job, NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })

  it('throws the suggester’s error for the queue to classify', async () => {
    const { db } = createTestDb()
    topic(db)
    const boom = new Error('quota')
    await expect(
      runSuggest({ db, suggester: { suggest: vi.fn().mockRejectedValue(boom) } }, queued(db), NOW),
    ).rejects.toBe(boom)
  })

  it('refuses unreadable params rather than guessing', () => {
    expect(() => parseRoundJob('{"round":1}')).toThrow()
    expect(() => parseRoundJob(null)).toThrow()
  })

  it('does nothing for a job whose topic is gone', async () => {
    const { db } = createTestDb()
    const jobId = enqueueJob(db, { kind: 'suggest', topicId: null, paramsJson: '{"round":1,"count":10,"mix":"mieszane"}' }, NOW)
    const s = suggester([it_('a')])
    await runSuggest({ db, suggester: s }, jobRow(db, jobId), NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })
})

describe('acceptRound', () => {
  function round1(db: Db) {
    topic(db)
    return ['gorączka', 'katar', 'osłuchać'].map((w) => suggestion(db, w))
  }

  it('turns every item not struck out into a queued, audio-less capture with a new job', () => {
    const { db } = createTestDb()
    const [a, b, c] = round1(db)
    expect(acceptRound(db, 't1', 1, [b], null, NOW)).toEqual({ accepted: 2, nextJobId: null })

    const caps = db.select().from(captures).all()
    expect(caps.map((x) => [x.transcript, x.status, x.audioMediaId, x.topicId, x.glossRu]).sort()).toEqual([
      ['gorączka', 'queued', null, 't1', 'перевод'],
      ['osłuchać', 'queued', null, 't1', 'перевод'],
    ])
    const jobs = db.select().from(generationJobs).all()
    expect(jobs.map((j) => j.kind)).toEqual(['new', 'new'])
    expect(new Set(jobs.map((j) => j.captureId))).toEqual(new Set(caps.map((x) => x.id)))

    const byId = new Map(db.select().from(suggestions).all().map((s) => [s.id, s]))
    expect(byId.get(a)!.status).toBe('accepted')
    expect(byId.get(a)!.captureId).not.toBeNull()
    expect(byId.get(b)!).toMatchObject({ status: 'rejected', captureId: null })
    expect(byId.get(c)!.status).toBe('accepted')
  })

  it('changes nothing when repeated', () => {
    const { db } = createTestDb()
    round1(db)
    acceptRound(db, 't1', 1, [], null, NOW)
    expect(acceptRound(db, 't1', 1, [], null, NOW)).toEqual({ accepted: 0, nextJobId: null })
    expect(db.select().from(captures).all()).toHaveLength(3)
  })

  it('touches only the given round', () => {
    const { db } = createTestDb()
    round1(db)
    suggestion(db, 'L4', { round: 2 })
    acceptRound(db, 't1', 2, [], null, NOW)
    expect(db.select().from(suggestions).where(eq(suggestions.round, 1)).all().every((s) => s.status === 'proposed')).toBe(true)
  })

  it('queues exactly one next round when asked', () => {
    const { db } = createTestDb()
    round1(db)
    const { nextJobId } = acceptRound(db, 't1', 1, [], { count: 5, mix: 'frazy' }, NOW)!
    expect(parseRoundJob(jobRow(db, nextJobId!).paramsJson)).toEqual({ round: 2, count: 5, mix: 'frazy' })
    expect(acceptRound(db, 't1', 1, [], { count: 5, mix: 'frazy' }, NOW)!.nextJobId).toBeNull()
    expect(db.select().from(generationJobs).where(eq(generationJobs.kind, 'suggest')).all()).toHaveLength(1)
  })

  it('answers null for an unknown topic', () => {
    const { db } = createTestDb()
    expect(acceptRound(db, 'nope', 1, [], null, NOW)).toBeNull()
  })
})

describe('createTopic', () => {
  it('stores the trimmed context and queues round 1', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: '  u mechanika  ', count: 5, mix: 'slowa' }, NOW)
    expect(db.select().from(topics).get()).toMatchObject({ id, name: null, context: 'u mechanika', suspendedAt: null })
    expect(parseRoundJob(activeSuggestJob(db, id)!.paramsJson)).toEqual({ round: 1, count: 5, mix: 'slowa' })
  })
})

describe('topicView', () => {
  it('is searching while a round is in flight', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane' }, NOW)
    expect(topicView(db, id)).toMatchObject({ state: 'searching', round: 0, items: [] })
  })

  it('is failed, with the error, when the latest round gave up', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane' }, NOW)
    db.update(generationJobs).set({ status: 'failed', lastError: 'unusable payload' }).run()
    expect(topicView(db, id)).toMatchObject({ state: 'failed', error: 'unusable payload' })
  })

  it('is ready with the latest round’s proposed items, then idle once they are decided', () => {
    const { db } = createTestDb()
    topic(db)
    suggestion(db, 'katar', { round: 1, status: 'accepted' })
    suggestion(db, 'gorączka', { round: 2 })
    expect(topicView(db, 't1')).toMatchObject({
      state: 'ready', round: 2, items: [{ id: 's-gorączka', answerPl: 'gorączka', glossRu: 'перевод', kind: 'slowo' }],
    })
    acceptRound(db, 't1', 2, [], null, NOW)
    expect(topicView(db, 't1')).toMatchObject({ state: 'idle', round: 2, items: [] })
  })

  it('lists the topic’s live cards and its pending items, and nothing else', () => {
    const { db } = createTestDb()
    topic(db)
    topic(db, 't2')
    const mine = card(db, 'katar')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, mine)).run()
    const gone = card(db, 'kaszel')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, gone)).run()
    deleteCard(db, gone, NOW)
    card(db, 'kot')
    suggestion(db, 'gorączka')
    acceptRound(db, 't1', 1, [], null, NOW)
    const v = topicView(db, 't1')!
    expect(v.cards.map((c) => c.answerPl)).toEqual(['katar'])
    expect(v.pending).toEqual([{ id: expect.any(String), transcript: 'gorączka', status: 'queued' }])
  })

  it('is null for an unknown topic', () => {
    const { db } = createTestDb()
    expect(topicView(db, 'nope')).toBeNull()
  })
})

describe('listTopics', () => {
  it('counts live cards and pending items per topic, newest topic first', () => {
    const { db } = createTestDb()
    topic(db, 't1', { createdAt: 1 })
    topic(db, 't2', { createdAt: 2 })
    const k = card(db, 'katar')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, k)).run()
    suggestion(db, 'gorączka')
    acceptRound(db, 't1', 1, [], null, NOW)
    expect(listTopics(db).map((t) => [t.id, t.cardCount, t.pendingCount])).toEqual([
      ['t2', 0, 0],
      ['t1', 1, 1],
    ])
  })
})

describe('updateTopic', () => {
  it('renames, edits the context and switches the topic off and on', () => {
    const { db } = createTestDb()
    topic(db)
    expect(updateTopic(db, 't1', { name: 'U lekarza', context: 'nowy kontekst', suspendedAt: 5 })).toMatchObject({
      name: 'U lekarza', context: 'nowy kontekst', suspendedAt: 5,
    })
    expect(updateTopic(db, 't1', { suspendedAt: null })!.suspendedAt).toBeNull()
    expect(updateTopic(db, 'nope', { name: 'x' })).toBeNull()
  })
})

describe('retrySuggest', () => {
  it('re-queues a failed round with the same params, and only then', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 5, mix: 'frazy' }, NOW)
    expect(retrySuggest(db, id, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const again = retrySuggest(db, id, NOW)!
    expect(parseRoundJob(jobRow(db, again).paramsJson)).toEqual({ round: 1, count: 5, mix: 'frazy' })
    expect(retrySuggest(db, id, NOW)).toBeNull()
  })
})
