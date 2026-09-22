import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-captures-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const transcribeMock = vi.fn().mockResolvedValue('kot')
vi.mock('@/lib/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcribe')>()
  return { ...actual, getTranscriber: () => ({ transcribe: transcribeMock }) }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs, media, topics } = await import('@/lib/db/schema')

function upload(lang?: string, topicId?: string) {
  const form = new FormData()
  form.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'capture.webm')
  if (lang !== undefined) form.set('lang', lang)
  if (topicId !== undefined) form.set('topicId', topicId)
  return POST(new Request('http://test/api/captures', { method: 'POST', body: form }))
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(media).run()
  db.delete(topics).run()
  transcribeMock.mockClear()
})

describe('POST /api/captures', () => {
  it.each(['pl', 'ru'])('stores a %s recording', async (lang) => {
    const res = await upload(lang)
    expect(res.status).toBe(202)
    expect(db.select().from(captures).get()!.lang).toBe(lang)
  })

  // An outbox entry saved before the language existed still uploads.
  it('stores a recording without a language as Polish', async () => {
    await upload()
    expect(db.select().from(captures).get()!.lang).toBe('pl')
  })

  it('refuses an unknown language and stores nothing', async () => {
    expect((await upload('de')).status).toBe(400)
    expect(db.select().from(captures).all()).toEqual([])
    expect(db.select().from(media).all()).toEqual([])
  })

  it('files the recording into the topic it was made under', async () => {
    db.insert(topics).values({ id: 't1', name: 'Praca w IT', context: 'programowanie', suspendedAt: null, createdAt: 1, isDefault: false }).run()
    const res = await upload('pl', 't1')
    expect(res.status).toBe(202)
    expect(db.select().from(captures).get()!.topicId).toBe('t1')
  })

  it('stores no topic when none was sent, as before', async () => {
    await upload('pl')
    expect(db.select().from(captures).get()!.topicId).toBeNull()
  })

  it('refuses an unknown topic rather than misfiling the word', async () => {
    const res = await upload('pl', 'gone')
    expect(res.status).toBe(400)
    expect(db.select().from(captures).all()).toHaveLength(0)
  })
})
