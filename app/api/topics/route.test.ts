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
const roundRoute = await import('./[id]/rounds/[round]/route')
const retryRoute = await import('./[id]/retry/route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs, suggestions, topics } = await import('@/lib/db/schema')
const { TranscriptionError } = await import('@/lib/transcribe')

const json = (body: unknown, method = 'POST') =>
  new Request('http://test/api/topics', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) })

beforeEach(() => {
  db.delete(suggestions).run()
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(topics).run()
  transcribeMock.mockReset()
})

async function created() {
  const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'mieszane' }))
  return ((await res.json()) as { topicId: string }).topicId
}

describe('POST /api/topics', () => {
  it('creates the topic and queues its first round', async () => {
    const res = await topicsRoute.POST(json({ context: 'u mechanika', count: 10, mix: 'slowa' }))
    expect(res.status).toBe(201)
    const { topicId } = (await res.json()) as { topicId: string }
    expect(db.select().from(generationJobs).get()).toMatchObject({ kind: 'suggest', topicId })
  })

  it.each([
    { context: '', count: 10, mix: 'mieszane' },
    { context: 'x', count: 7, mix: 'mieszane' },
    { context: 'x', count: 10, mix: 'wszystko' },
  ])('refuses %o', async (body) => {
    expect((await topicsRoute.POST(json(body))).status).toBe(400)
  })
})

describe('GET /api/topics', () => {
  it('lists topics with their counts', async () => {
    const id = await created()
    const body = (await (await topicsRoute.GET()).json()) as { topics: { id: string; cardCount: number }[] }
    expect(body.topics).toEqual([expect.objectContaining({ id, cardCount: 0, pendingCount: 0 })])
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
    expect(await res.json()).toMatchObject({ topic: { id }, state: 'searching' })
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

describe('POST /api/topics/:id/rounds/:round', () => {
  it('accepts the round and queues the next', async () => {
    const id = await created()
    db.update(generationJobs).set({ status: 'done' }).run()
    db.insert(suggestions).values({
      id: 's1', topicId: id, round: 1, answerPl: 'sprzęgło', glossRu: 'сцепление', kind: 'slowo',
      status: 'proposed', captureId: null, createdAt: 1,
    }).run()
    const res = await roundRoute.POST(json({ rejected: [], next: { count: 5, mix: 'frazy' } }), params({ id, round: '1' }))
    expect(await res.json()).toEqual({ accepted: 1, nextJobId: expect.any(String) })
  })

  it('refuses a bad round number or body, and an unknown topic', async () => {
    const id = await created()
    expect((await roundRoute.POST(json({ rejected: [] }), params({ id, round: 'x' }))).status).toBe(400)
    expect((await roundRoute.POST(json({}), params({ id, round: '1' }))).status).toBe(400)
    expect((await roundRoute.POST(json({ rejected: [] }), params({ id: 'nope', round: '1' }))).status).toBe(404)
  })
})

describe('POST /api/topics/:id/retry', () => {
  it('re-queues a failed round', async () => {
    const id = await created()
    db.update(generationJobs).set({ status: 'failed' }).run()
    const res = await retryRoute.POST(new Request('http://test', { method: 'POST' }), params({ id }))
    expect(await res.json()).toEqual({ jobId: expect.any(String) })
  })
})
