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
const { captures, generationJobs, media } = await import('@/lib/db/schema')

function upload(lang?: string) {
  const form = new FormData()
  form.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'capture.webm')
  if (lang !== undefined) form.set('lang', lang)
  return POST(new Request('http://test/api/captures', { method: 'POST', body: form }))
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(captures).run()
  db.delete(media).run()
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
})
