import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Same seam as app/api/topics/route.test.ts: point the real db client at a
// throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-topic-items-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const batchesRoute = await import('./[id]/batches/route')
const itemsRoute = await import('./[id]/items/route')
const itemRoute = await import('./[id]/items/[itemId]/route')
const cardRoute = await import('./[id]/items/[itemId]/card/route')
const discardRoute = await import('./[id]/items/[itemId]/discard/route')
const restoreRoute = await import('./[id]/items/[itemId]/restore/route')
const { db } = await import('@/lib/db/client')
const { captures, cards, generationJobs, topicItems, topics } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { DEFAULT_TOPIC_ID } = await import('@/lib/topics/default')
const { newState } = await import('@/lib/scheduler')

const NOW = new Date('2026-09-19T10:00:00')

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })
const post = (body?: unknown) =>
  new Request('http://test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  })
const patchReq = (body: unknown) =>
  new Request('http://test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function makeTopic(id: string, overrides: Partial<typeof topics.$inferInsert> = {}) {
  db.insert(topics)
    .values({ id, name: 'Temat', context: 'kontekst', suspendedAt: null, createdAt: NOW.getTime(), isDefault: false, ...overrides })
    .run()
  return id
}

async function addItem(topicId: string, text: string) {
  const res = await itemsRoute.POST(post({ text }), params({ id: topicId }))
  expect(res.status).toBe(201)
  return ((await res.json()) as { item: { id: string } }).item.id
}

function seedCard(overrides: Partial<typeof cards.$inferInsert> & { id: string }) {
  db.insert(cards)
    .values({
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
      topicId: DEFAULT_TOPIC_ID,
      ...newState(NOW),
      ...overrides,
    })
    .run()
  return overrides.id
}

beforeEach(() => {
  db.delete(topicItems).run()
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(cards).run()
  // Ogólne comes with the migration and stays.
  db.delete(topics).where(eq(topics.isDefault, false)).run()
})

describe('POST /api/topics/:id/batches', () => {
  it('queues a batch and returns its job id', async () => {
    const id = makeTopic('t1')
    const res = await batchesRoute.POST(post({ count: 10, mix: 'mieszane', level: 'zaawansowany' }), params({ id }))
    expect(res.status).toBe(202)
    const { jobId } = (await res.json()) as { jobId: string | null }
    expect(jobId).not.toBeNull()
    const job = db.select().from(generationJobs).get()!
    expect(job).toMatchObject({ kind: 'suggest', topicId: id })
  })

  it('returns a null job id while a batch is already running', async () => {
    const id = makeTopic('t2')
    db.insert(generationJobs)
      .values({
        id: 'job-running',
        kind: 'suggest',
        captureId: null,
        cardId: null,
        status: 'queued',
        attempts: 0,
        failures: 0,
        nextAttemptAt: NOW.getTime(),
        lastError: null,
        createdAt: NOW.getTime(),
        finishedAt: null,
        topicId: id,
        paramsJson: JSON.stringify({ count: 10, mix: 'mieszane', level: 'zaawansowany' }),
      })
      .run()
    const res = await batchesRoute.POST(post({ count: 10, mix: 'mieszane', level: 'zaawansowany' }), params({ id }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ jobId: null })
  })

  it('refuses a bad body with 400', async () => {
    const id = makeTopic('t3')
    const res = await batchesRoute.POST(post({ count: 7, mix: 'mieszane', level: 'zaawansowany' }), params({ id }))
    expect(res.status).toBe(400)
  })

  it('refuses the default topic with 400', async () => {
    const res = await batchesRoute.POST(
      post({ count: 10, mix: 'mieszane', level: 'zaawansowany' }),
      params({ id: DEFAULT_TOPIC_ID }),
    )
    expect(res.status).toBe(400)
  })

  it('is 404 for an unknown topic', async () => {
    const res = await batchesRoute.POST(post({ count: 10, mix: 'mieszane', level: 'zaawansowany' }), params({ id: 'nope' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/topics/:id/items', () => {
  it('adds a hand-typed item', async () => {
    const id = makeTopic('t4')
    const res = await itemsRoute.POST(post({ text: 'wesele' }), params({ id }))
    expect(res.status).toBe(201)
    const { item } = (await res.json()) as { item: { answerPl: string; source: string } }
    expect(item).toMatchObject({ answerPl: 'wesele', source: 'manual' })
  })

  it('refuses an empty text with 400', async () => {
    const id = makeTopic('t5')
    const res = await itemsRoute.POST(post({ text: '   ' }), params({ id }))
    expect(res.status).toBe(400)
  })

  it('is 404 for an unknown topic', async () => {
    const res = await itemsRoute.POST(post({ text: 'wesele' }), params({ id: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('refuses a word the topic already holds with 409', async () => {
    const id = makeTopic('t6')
    await addItem(id, 'wesele')
    const res = await itemsRoute.POST(post({ text: 'wesele' }), params({ id }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'już jest w tym temacie' })
  })

  it('refuses a word already in the deck with 409, naming its topic', async () => {
    const id = makeTopic('t7')
    const deckTopic = makeTopic('t8', { name: 'U lekarza' })
    seedCard({ id: 'c1', answerPl: 'złośliwy', answerKey: 'złośliwy', topicId: deckTopic })
    const res = await itemsRoute.POST(post({ text: 'złośliwy' }), params({ id }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'już masz — w temacie U lekarza' })
  })
})

describe('POST /api/topics/:id/items/:itemId/card', () => {
  it('turns an open item into a queued capture', async () => {
    const id = makeTopic('t9')
    const itemId = await addItem(id, 'wesele')
    const res = await cardRoute.POST(post(), params({ id, itemId }))
    expect(res.status).toBe(202)
    const { captureId } = (await res.json()) as { captureId: string }
    expect(captureId).toEqual(expect.any(String))
    expect(db.select().from(topicItems).where(eq(topicItems.id, itemId)).get()).toMatchObject({ status: 'carded', captureId })
  })

  it('is 404 for an unknown item', async () => {
    const id = makeTopic('t10')
    const res = await cardRoute.POST(post(), params({ id, itemId: 'nope' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/topics/:id/items/:itemId/discard', () => {
  it('discards an open item', async () => {
    const id = makeTopic('t11')
    const itemId = await addItem(id, 'wesele')
    const res = await discardRoute.POST(post(), params({ id, itemId }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.select().from(topicItems).where(eq(topicItems.id, itemId)).get()).toMatchObject({ status: 'discarded' })
  })

  it('is 404 for an unknown item', async () => {
    const id = makeTopic('t12')
    const res = await discardRoute.POST(post(), params({ id, itemId: 'nope' }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/topics/:id/items/:itemId/restore', () => {
  it('restores a discarded item to open', async () => {
    const id = makeTopic('t13')
    const itemId = await addItem(id, 'wesele')
    await discardRoute.POST(post(), params({ id, itemId }))
    const res = await restoreRoute.POST(post(), params({ id, itemId }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.select().from(topicItems).where(eq(topicItems.id, itemId)).get()).toMatchObject({ status: 'open' })
  })

  it('is 404 for an unknown item', async () => {
    const id = makeTopic('t14')
    const res = await restoreRoute.POST(post(), params({ id, itemId: 'nope' }))
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/topics/:id/items/:itemId', () => {
  it('moves an item to another topic', async () => {
    const id = makeTopic('t15')
    const other = makeTopic('t16')
    const itemId = await addItem(id, 'wesele')
    const res = await itemRoute.PATCH(patchReq({ topicId: other }), params({ id, itemId }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.select().from(topicItems).where(eq(topicItems.id, itemId)).get()).toMatchObject({ topicId: other })
  })

  it('refuses a bad body with 400', async () => {
    const id = makeTopic('t17')
    const itemId = await addItem(id, 'wesele')
    const res = await itemRoute.PATCH(patchReq({ topicId: '' }), params({ id, itemId }))
    expect(res.status).toBe(400)
  })

  it('is 404 for an unknown item or topic', async () => {
    const id = makeTopic('t18')
    const itemId = await addItem(id, 'wesele')
    expect((await itemRoute.PATCH(patchReq({ topicId: id }), params({ id, itemId: 'nope' }))).status).toBe(404)
    expect((await itemRoute.PATCH(patchReq({ topicId: 'nope' }), params({ id, itemId }))).status).toBe(404)
  })
})
