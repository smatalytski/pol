import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-topics-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const transcribeMock = vi.fn()
vi.mock('@/lib/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcribe')>()
  return { ...actual, getTranscriber: () => ({ transcribe: transcribeMock }) }
})

const topicsRoute = await import('./route')
const transcribeRoute = await import('./transcribe/route')
const topicRoute = await import('./[id]/route')
const retryRoute = await import('./[id]/retry/route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs, topicItems, topics } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { DEFAULT_TOPIC_ID } = await import('@/lib/topics/default')
const { TranscriptionError } = await import('@/lib/transcribe')

const json = (body: unknown, method = 'POST') =>
  new Request('http://test/api/topics', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

beforeEach(() => {
  db.delete(topicItems).run()
  db.delete(generationJobs).run()
  db.delete(captures).run()
  // Ogólne comes with the migration and stays.
  db.delete(topics).where(eq(topics.isDefault, false)).run()
  transcribeMock.mockReset()
})

async function created() {
  const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'mieszane', level: 'zaawansowany' }))
  return ((await res.json()) as { topicId: string }).topicId
}

describe('POST /api/topics', () => {
  it('creates the topic and queues its first batch at the chosen level', async () => {
    const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'slowa', level: 'sredni' }))
    expect(res.status).toBe(201)
    const { topicId } = (await res.json()) as { topicId: string }
    const job = db.select().from(generationJobs).get()!
    expect(job).toMatchObject({ kind: 'suggest', topicId })
    expect(JSON.parse(job.paramsJson!)).toEqual({ count: 10, mix: 'slowa', level: 'sredni' })
  })

  it.each([
    { context: '', count: 10, mix: 'mieszane', level: 'zaawansowany' },
    { context: 'x', count: 7, mix: 'mieszane', level: 'zaawansowany' },
    { context: 'x', count: 10, mix: 'wszystko', level: 'zaawansowany' },
    { context: 'x', count: 10, mix: 'mieszane' },
    { context: 'x', count: 10, mix: 'mieszane', level: 'latwy' },
  ])('refuses %o', async (body) => {
    expect((await topicsRoute.POST(json(body))).status).toBe(400)
  })
})

describe('GET /api/topics', () => {
  it('lists topics with their counts, the default topic first', async () => {
    const id = await created()
    const body = (await (await topicsRoute.GET()).json()) as { topics: { id: string; cardCount: number }[] }
    expect(body.topics).toEqual([
      expect.objectContaining({ id: DEFAULT_TOPIC_ID, isDefault: true }),
      expect.objectContaining({ id, cardCount: 0, openCount: 0, discardedCount: 0, pendingCount: 0, searching: true }),
    ])
  })
})

describe('POST /api/topics/transcribe', () => {
  function form(lang?: string) {
    const f = new FormData()
    f.set('audio', new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }))
    if (lang) f.set('lang', lang)
    return new Request('http://test/api/topics/transcribe', { method: 'POST', body: f })
  }

  it('recognises in Russian by default, and stores nothing', async () => {
    transcribeMock.mockResolvedValue('иду к врачу с ребёнком')
    const res = await transcribeRoute.POST(form())
    expect(await res.json()).toEqual({ transcript: 'иду к врачу с ребёнком' })
    expect(transcribeMock.mock.calls[0][0].lang).toBe('ru')
    expect(db.select().from(captures).all()).toEqual([])
  })

  it('recognises in Polish on request', async () => {
    transcribeMock.mockResolvedValue('u lekarza')
    await transcribeRoute.POST(form('pl'))
    expect(transcribeMock.mock.calls[0][0].lang).toBe('pl')
  })

  it('reports a recognition failure', async () => {
    transcribeMock.mockRejectedValue(new TranscriptionError('no speech'))
    const res = await transcribeRoute.POST(form())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'no speech' })
  })
})

describe('GET and PATCH /api/topics/:id', () => {
  it('returns the view', async () => {
    const id = await created()
    const res = await topicRoute.GET(new Request('http://test'), params({ id }))
    expect(await res.json()).toMatchObject({
      topic: { id },
      groups: { carded: [], open: [], discarded: [] },
      pending: [],
      batch: { state: 'searching', error: null },
    })
  })

  it('is 404 for an unknown topic', async () => {
    expect((await topicRoute.GET(new Request('http://test'), params({ id: 'nope' }))).status).toBe(404)
    expect((await topicRoute.PATCH(json({ name: 'x' }, 'PATCH'), params({ id: 'nope' }))).status).toBe(404)
  })

  it('switches a topic off', async () => {
    const id = await created()
    const res = await topicRoute.PATCH(json({ suspendedAt: 123 }, 'PATCH'), params({ id }))
    expect(await res.json()).toMatchObject({ topic: { id, suspendedAt: 123 } })
  })

  it('refuses an empty name', async () => {
    const id = await created()
    expect((await topicRoute.PATCH(json({ name: ' ' }, 'PATCH'), params({ id }))).status).toBe(400)
  })
})

describe('POST /api/topics/:id/retry', () => {
  it('re-queues a failed batch', async () => {
    const id = await created()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const res = await retryRoute.POST(new Request('http://test', { method: 'POST' }), params({ id }))
    expect(await res.json()).toEqual({ jobId: expect.any(String) })
  })
})
