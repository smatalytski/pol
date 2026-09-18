import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, generationJobs, suggestions, topics } from '../db/schema'
import { createCard, deleteCard } from '../cards/service'
import type { Suggestion, Suggester } from '../generate'
import { enqueueJob } from '../queue/jobs'
import { activeSuggestJob, enqueueSuggest, latestRound, parseRoundJob, runSuggest } from './service'

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
