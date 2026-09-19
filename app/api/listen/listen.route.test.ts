import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { CreateCardInput } from '@/lib/cards/service'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-listen-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

/** Deterministic, per-(lang,text) bytes — mirrors lib/audio/card-audio.test.ts's fake. */
function clipBytes(lang: 'pl' | 'ru', text: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([lang, ...text]))
}

const synthesizeMock = vi.fn(async (text: string, lang: 'pl' | 'ru') => ({
  bytes: clipBytes(lang, text),
  mime: 'audio/mpeg',
  voice: `${lang}-voice`,
}))
vi.mock('@/lib/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tts')>()
  return { ...actual, getSynthesizer: () => ({ synthesize: synthesizeMock }) }
})

const encodeMock = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), durationMs: 9000 }))
vi.mock('@/lib/audio/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/ffmpeg')>()
  return { ...actual, getEncoder: () => ({ encode: encodeMock }) }
})

const sessionRoute = await import('./session/route')
const audioRoute = await import('./cards/[id]/audio/route')
const heardRoute = await import('./heard/route')
const { db } = await import('@/lib/db/client')
const { cardAudio, cards, listens, media, topics, ttsClips } = await import('@/lib/db/schema')
const { createCard } = await import('@/lib/cards/service')
const { FfmpegMissingError } = await import('@/lib/audio/ffmpeg')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const json = (body: unknown) =>
  new Request('http://test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function mkCard(over: Partial<CreateCardInput> = {}): string {
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
    new Date('2026-09-19T10:00:00'),
  )
  return cardId
}

beforeEach(() => {
  db.delete(listens).run()
  db.delete(cardAudio).run()
  db.delete(ttsClips).run()
  db.delete(media).run()
  db.delete(cards).run()
  // Ogólne comes with the migration and stays.
  db.delete(topics).where(eq(topics.isDefault, false)).run()
  synthesizeMock.mockClear()
  synthesizeMock.mockImplementation(async (text: string, lang: 'pl' | 'ru') => ({
    bytes: clipBytes(lang, text),
    mime: 'audio/mpeg',
    voice: `${lang}-voice`,
  }))
  encodeMock.mockClear()
  encodeMock.mockImplementation(async () => ({ bytes: new Uint8Array([1, 2, 3]), durationMs: 9000 }))
})

describe('POST /api/listen/session', () => {
  it('plans a session and returns its cards', async () => {
    const id = mkCard()
    const res = await sessionRoute.POST(json({ minutes: 10 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cards: { id: string }[] }
    expect(body.cards).toEqual([expect.objectContaining({ id })])
  })

  it.each([
    { minutes: 15 },
    { minutes: '10' },
    { minutes: 10, topicIds: 'x' },
    {},
  ])('refuses a bad body %o', async (body) => {
    expect((await sessionRoute.POST(json(body))).status).toBe(400)
  })
})

describe('GET /api/listen/cards/:id/audio', () => {
  it('builds and returns the mp3 with cache headers and an ETag of the key', async () => {
    const id = mkCard()
    const res = await audioRoute.GET(new Request('http://test'), params(id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const etag = res.headers.get('etag')
    expect(etag).toMatch(/^".+"$/)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    const row = db.select().from(cardAudio).get()!
    expect(etag).toBe(`"${row.key}"`)
  })

  it('is 404 for an unknown card', async () => {
    const res = await audioRoute.GET(new Request('http://test'), params('nope'))
    expect(res.status).toBe(404)
  })

  it('is 404 for an ineligible card (pl_to_pl)', async () => {
    const id = mkCard({ type: 'pl_to_pl', answerPl: 'inny' })
    const res = await audioRoute.GET(new Request('http://test'), params(id))
    expect(res.status).toBe(404)
  })

  it('is 503 when ffmpeg is missing', async () => {
    encodeMock.mockImplementation(async () => {
      throw new FfmpegMissingError('ffmpeg is not installed')
    })
    const id = mkCard({ answerPl: 'brak-ffmpeg' })
    const res = await audioRoute.GET(new Request('http://test'), params(id))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'ffmpeg missing' })
  })

  it('is 502 when tts fails', async () => {
    synthesizeMock.mockRejectedValue(new Error('tts failed: boom'))
    const id = mkCard({ answerPl: 'tts-boom' })
    const res = await audioRoute.GET(new Request('http://test'), params(id))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'tts failed: boom' })
  })
})

describe('POST /api/listen/heard', () => {
  it('records a listen and returns 204', async () => {
    const id = mkCard()
    const res = await heardRoute.POST(json({ cardId: id }))
    expect(res.status).toBe(204)
    expect(db.select().from(listens).where(eq(listens.cardId, id)).all()).toHaveLength(1)
  })

  it('is 404 for an unknown card', async () => {
    const res = await heardRoute.POST(json({ cardId: 'nope' }))
    expect(res.status).toBe(404)
  })

  it.each([{}, { cardId: 3 }, { cardId: '' }])('refuses a bad body %o', async (body) => {
    expect((await heardRoute.POST(json(body))).status).toBe(400)
  })
})
