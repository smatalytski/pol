import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { captures, cards, generationJobs, topicItems, topics } from '../db/schema'
import { createCard, deleteCard } from '../cards/service'
import type { Suggestion, Suggester } from '../generate'
import { enqueueJob } from '../queue/jobs'
import { DEFAULT_TOPIC_ID } from './default'
import {
  activeSuggestJob,
  createTopic,
  enqueueSuggest,
  listTopics,
  parseBatchJob,
  retrySuggest,
  runSuggest,
  topicView,
  updateTopic,
} from './service'

type Db = ReturnType<typeof createTestDb>['db']
const NOW = new Date('2026-09-18T10:00:00')

function topic(db: Db, id = 't1', over: Partial<typeof topics.$inferInsert> = {}) {
  db.insert(topics).values({
    id, name: null, context: 'u lekarza z dzieckiem, grypa', suspendedAt: null, createdAt: NOW.getTime(), isDefault: false, ...over,
  }).run()
  return id
}

function item(db: Db, answerPl: string, over: Partial<typeof topicItems.$inferInsert> = {}) {
  const id = over.id ?? `i-${answerPl}`
  db.insert(topicItems).values({
    id, topicId: 't1', answerPl, glossRu: 'перевод', kind: 'slowo', source: 'suggested', level: 'zaawansowany',
    status: 'open', captureId: null, cardId: null, batchJobId: null, discardedAt: null, createdAt: NOW.getTime(), ...over,
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
  it('queues a batch with its params', () => {
    const { db } = createTestDb()
    topic(db)
    const id = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'sredni' }, NOW)!
    expect(jobRow(db, id)).toMatchObject({ kind: 'suggest', topicId: 't1', status: 'queued' })
    expect(parseBatchJob(jobRow(db, id).paramsJson)).toEqual({ count: 10, mix: 'mieszane', level: 'sredni' })
  })

  it('refuses a second batch while one is queued or running', () => {
    const { db } = createTestDb()
    topic(db)
    const first = enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)!
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'running' }).where(eq(generationJobs.id, first)).run()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).where(eq(generationJobs.id, first)).run()
    expect(activeSuggestJob(db, 't1')).toBeUndefined()
    expect(enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)).not.toBeNull()
  })
})

describe('runSuggest', () => {
  function queued(db: Db, count = 10, mix: 'mieszane' | 'slowa' | 'frazy' = 'mieszane') {
    return jobRow(db, enqueueSuggest(db, 't1', { count, mix, level: 'zaawansowany' }, NOW)!)
  }

  it('asks for count × 1.5 split by the mix, excluding the topic history', async () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'katar', { status: 'discarded' })
    item(db, 'kaszel', { status: 'carded' })
    const s = suggester([])
    await runSuggest({ db, suggester: s }, queued(db, 10, 'slowa'), NOW)
    expect(s.suggest).toHaveBeenCalledWith({
      context: 'u lekarza z dzieckiem, grypa', count: 15, words: 15, phrases: 0, exclude: ['katar', 'kaszel'], level: 'zaawansowany',
    })
  })

  it('stores the batch as open, dropping deck words, history and repeats, trimmed to count', async () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'katar', { status: 'discarded' })
    card(db, 'gorączka')
    const s = suggester([it_('Gorączka'), it_('katar'), it_('osłuchać'), it_('osłuchać'), it_('L4'), it_('recepta')])
    const job = queued(db, 2)
    await runSuggest({ db, suggester: s }, job, NOW)
    const batch = db.select().from(topicItems).where(eq(topicItems.batchJobId, job.id)).all()
    expect(batch.map((r) => [r.answerPl, r.glossRu, r.status])).toEqual([
      ['osłuchać', 'ru:osłuchać', 'open'],
      ['L4', 'ru:L4', 'open'],
    ])
  })

  it('ignores deleted cards and forms-only cards when checking the deck', async () => {
    const { db } = createTestDb()
    topic(db)
    deleteCard(db, card(db, 'gorączka'), NOW)
    card(db, 'katar', { type: 'pl_to_pl' })
    await runSuggest({ db, suggester: suggester([it_('gorączka'), it_('katar')]) }, queued(db), NOW)
    expect(db.select().from(topicItems).all()).toHaveLength(2)
  })

  it('names an unnamed topic, and leaves a named one alone', async () => {
    const { db } = createTestDb()
    topic(db)
    const name = () => db.select().from(topics).where(eq(topics.id, 't1')).get()!.name
    await runSuggest({ db, suggester: suggester([it_('a')], 'U lekarza') }, queued(db), NOW)
    expect(name()).toBe('U lekarza')
    db.update(generationJobs).set({ status: 'done' }).run()
    await runSuggest({ db, suggester: suggester([it_('b')], 'Inna nazwa') }, queued(db), NOW)
    expect(name()).toBe('U lekarza')
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
    expect(() => parseBatchJob('{"count":10}')).toThrow()
    expect(() => parseBatchJob('{"count":10,"mix":"mieszane","level":"latwy"}')).toThrow()
    expect(() => parseBatchJob(null)).toThrow()
  })

  it('does nothing for a job whose topic is gone', async () => {
    const { db } = createTestDb()
    const jobId = enqueueJob(db, { kind: 'suggest', topicId: null, paramsJson: '{"count":10,"mix":"mieszane","level":"sredni"}' }, NOW)
    const s = suggester([it_('a')])
    await runSuggest({ db, suggester: s }, jobRow(db, jobId), NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })

  // A job queued before levels existed (a round job: {"round","count","mix"})
  // may still be waiting, or failed and retried, when this version deploys.
  it('reads a legacy round job with no stored level as zaawansowany', async () => {
    const { db } = createTestDb()
    topic(db)
    const jobId = enqueueJob(db, { kind: 'suggest', topicId: 't1', paramsJson: '{"round":1,"count":10,"mix":"mieszane"}' }, NOW)
    expect(parseBatchJob(jobRow(db, jobId).paramsJson)).toEqual({ count: 10, mix: 'mieszane', level: 'zaawansowany' })
    const s = suggester([])
    await runSuggest({ db, suggester: s }, jobRow(db, jobId), NOW)
    expect(s.suggest).toHaveBeenCalledWith(expect.objectContaining({ level: 'zaawansowany' }))
  })
})

describe('batches (spec 2026-09-19-topic-items §4.5)', () => {
  it('stores a batch as open suggested items with its level and job id', async () => {
    const { db } = createTestDb()
    topic(db)
    const jobId = enqueueSuggest(db, 't1', { count: 2, mix: 'mieszane', level: 'sredni' }, NOW)!
    await runSuggest({ db, suggester: suggester([it_('katar'), it_('kaszel')]) }, jobRow(db, jobId), NOW)
    expect(db.select().from(topicItems).all().map((i) => [i.answerPl, i.status, i.source, i.level, i.batchJobId])).toEqual([
      ['katar', 'open', 'suggested', 'sredni', jobId],
      ['kaszel', 'open', 'suggested', 'sredni', jobId],
    ])
  })

  it('passes the level to the suggester', async () => {
    const { db } = createTestDb()
    topic(db)
    const s = suggester([])
    await runSuggest({ db, suggester: s }, jobRow(db, enqueueSuggest(db, 't1', { count: 10, mix: 'slowa', level: 'sredni' }, NOW)!), NOW)
    expect(s.suggest).toHaveBeenCalledWith(expect.objectContaining({ level: 'sredni', words: 15, phrases: 0 }))
  })

  it('excludes everything the topic ever held, in any status', async () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'a', { status: 'open' })
    item(db, 'b', { status: 'discarded' })
    item(db, 'c', { status: 'carded' })
    const s = suggester([it_('a'), it_('b'), it_('c'), it_('d')])
    await runSuggest({ db, suggester: s }, jobRow(db, enqueueSuggest(db, 't1', { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)!), NOW)
    expect(s.suggest).toHaveBeenCalledWith(expect.objectContaining({ exclude: ['a', 'b', 'c'] }))
    expect(db.select().from(topicItems).where(eq(topicItems.status, 'open')).all().map((i) => i.answerPl)).toEqual(['a', 'd'])
  })

  // The process died after storing the batch but before the job was marked
  // done; the job runs again and must not produce a second batch.
  it('does nothing when rerun after its batch was stored', async () => {
    const { db } = createTestDb()
    topic(db)
    const job = jobRow(db, enqueueSuggest(db, 't1', { count: 5, mix: 'mieszane', level: 'zaawansowany' }, NOW)!)
    await runSuggest({ db, suggester: suggester([it_('a')]) }, job, NOW)
    const s = suggester([it_('b')])
    await runSuggest({ db, suggester: s }, job, NOW)
    expect(s.suggest).not.toHaveBeenCalled()
  })

  it('never queues a batch for the default topic', () => {
    const { db } = createTestDb()
    expect(enqueueSuggest(db, DEFAULT_TOPIC_ID, { count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)).toBeNull()
  })
})

describe('createTopic', () => {
  it('stores the trimmed context and queues its first batch', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: '  u mechanika  ', count: 5, mix: 'slowa', level: 'sredni' }, NOW)
    expect(db.select().from(topics).where(eq(topics.id, id)).get()).toMatchObject({
      id, name: null, context: 'u mechanika', suspendedAt: null, isDefault: false,
    })
    expect(parseBatchJob(activeSuggestJob(db, id)!.paramsJson)).toEqual({ count: 5, mix: 'slowa', level: 'sredni' })
  })
})

describe('topicView', () => {
  it('is searching while a batch is in flight', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)
    expect(topicView(db, id)).toMatchObject({
      batch: { state: 'searching', error: null }, groups: { carded: [], open: [], discarded: [] },
    })
  })

  it('is failed, with the error, when the latest batch gave up', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)
    db.update(generationJobs).set({ status: 'failed', lastError: 'unusable payload' }).run()
    expect(topicView(db, id)).toMatchObject({ batch: { state: 'failed', error: 'unusable payload' } })
  })

  it('is idle once the batch is done, with its items open in the model’s order', () => {
    const { db } = createTestDb()
    topic(db)
    item(db, 'katar')
    item(db, 'gorączka', { glossRu: null, kind: null, source: 'manual', level: null })
    expect(topicView(db, 't1')).toMatchObject({
      batch: { state: 'idle', error: null },
      groups: {
        open: [
          { id: 'i-katar', answerPl: 'katar', glossRu: 'перевод', kind: 'slowo', source: 'suggested', level: 'zaawansowany' },
          { id: 'i-gorączka', answerPl: 'gorączka', glossRu: null, kind: null, source: 'manual', level: null },
        ],
      },
    })
  })

  it('lists the topic’s pending captures, and no other topic’s', () => {
    const { db } = createTestDb()
    topic(db)
    topic(db, 't2')
    const cap = (id: string, topicId: string, transcript: string) =>
      db.insert(captures).values({
        id, audioMediaId: null, transcript, status: 'queued', error: null, generationJson: null, cardId: null,
        createdAt: NOW.getTime(), transcribedAt: null, duplicateOf: null, topicId, glossRu: null,
      }).run()
    cap('c1', 't1', 'gorączka')
    cap('c2', 't2', 'sprzęgło')
    expect(topicView(db, 't1')!.pending).toEqual([{ id: 'c1', transcript: 'gorączka', status: 'queued' }])
  })

  it('is null for an unknown topic', () => {
    const { db } = createTestDb()
    expect(topicView(db, 'nope')).toBeNull()
  })
})

describe('topicView groups (§3.3)', () => {
  it('splits a topic into carded, open and discarded', () => {
    const { db } = createTestDb()
    topic(db)
    const live = card(db, 'kot'); db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, live)).run()
    const gone = card(db, 'pies'); db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, gone)).run()
    deleteCard(db, gone, new Date(NOW.getTime() + 10))
    item(db, 'katar', { status: 'open' })
    item(db, 'kaszel', { status: 'discarded', discardedAt: NOW.getTime() + 5 })
    item(db, 'x', { status: 'carded' })
    const v = topicView(db, 't1')!
    expect(v.groups.carded.map((c) => c.answerPl)).toEqual(['kot'])
    expect(v.groups.open.map((i) => i.answerPl)).toEqual(['katar'])
    expect(v.groups.discarded.map((d) => (d.kind === 'card' ? d.card.answerPl : d.item.answerPl))).toEqual(['pies', 'kaszel'])
  })
})

describe('listTopics', () => {
  it('lists the default topic first with all three counts', () => {
    const { db } = createTestDb()
    topic(db, 't1', { createdAt: NOW.getTime() + 1 })
    item(db, 'a', { status: 'open' })
    item(db, 'b', { status: 'discarded' })
    card(db, 'kot') // lands in the default topic
    const rows = listTopics(db)
    expect(rows[0]).toMatchObject({ id: DEFAULT_TOPIC_ID, cardCount: 1, openCount: 0, discardedCount: 0 })
    expect(rows[1]).toMatchObject({ id: 't1', cardCount: 0, openCount: 1, discardedCount: 1 })
  })

  it('counts live and deleted cards and pending captures per topic, newest topic first after the default', () => {
    const { db } = createTestDb()
    topic(db, 't1', { createdAt: 1 })
    topic(db, 't2', { createdAt: 2 })
    const k = card(db, 'katar')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, k)).run()
    const gone = card(db, 'kaszel')
    db.update(cards).set({ topicId: 't1' }).where(eq(cards.id, gone)).run()
    deleteCard(db, gone, NOW)
    db.insert(captures).values({
      id: 'c1', audioMediaId: null, transcript: 'gorączka', status: 'queued', error: null, generationJson: null, cardId: null,
      createdAt: NOW.getTime(), transcribedAt: null, duplicateOf: null, topicId: 't1', glossRu: null,
    }).run()
    expect(listTopics(db).map((t) => [t.id, t.cardCount, t.discardedCount, t.pendingCount])).toEqual([
      [DEFAULT_TOPIC_ID, 0, 0, 0],
      ['t2', 0, 0, 0],
      ['t1', 1, 1, 1],
    ])
  })

  // /tematy polls while a topic is still searching for a batch, so a
  // brand-new topic must not look permanently stuck at "nowy temat…" until
  // the page happens to reload.
  it('says a topic is searching while its suggest job is in flight, and not once it is done', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 10, mix: 'mieszane', level: 'zaawansowany' }, NOW)
    const searching = () => listTopics(db).find((t) => t.id === id)!.searching
    expect(searching()).toBe(true)
    db.update(generationJobs).set({ status: 'done' }).run()
    expect(searching()).toBe(false)
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
  it('re-queues a failed batch with the same params, and only then', () => {
    const { db } = createTestDb()
    const id = createTopic(db, { context: 'x', count: 5, mix: 'frazy', level: 'sredni' }, NOW)
    expect(retrySuggest(db, id, NOW)).toBeNull()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const again = retrySuggest(db, id, NOW)!
    expect(parseBatchJob(jobRow(db, again).paramsJson)).toEqual({ count: 5, mix: 'frazy', level: 'sredni' })
    expect(retrySuggest(db, id, NOW)).toBeNull()
  })

  // Same legacy case as runSuggest's: retrying a failed round job from before
  // levels existed must not throw, and the new job carries a level.
  it('re-queues a legacy failed round job as a zaawansowany batch', () => {
    const { db } = createTestDb()
    topic(db)
    const jobId = enqueueJob(db, { kind: 'suggest', topicId: 't1', paramsJson: '{"round":1,"count":10,"mix":"mieszane"}' }, NOW)
    db.update(generationJobs).set({ status: 'failed' }).where(eq(generationJobs.id, jobId)).run()
    const again = retrySuggest(db, 't1', NOW)!
    expect(JSON.parse(jobRow(db, again).paramsJson!)).toEqual({ count: 10, mix: 'mieszane', level: 'zaawansowany' })
  })
})
