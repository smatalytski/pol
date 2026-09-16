import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// Same seam as the other route tests: point the real db client at a
// throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-images-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

type GeneratedCard = {
  answer_pl: string
  prompt_ru: string
  prompt_hint: string
  example_pl: string
  example_ru: string
  grammar_note: string
}

function generated(answerPl: string): GeneratedCard {
  return { answer_pl: answerPl, prompt_ru: '', prompt_hint: '', example_pl: '', example_ru: '', grammar_note: '' }
}

const fromImageMock = vi.fn<(image: { bytes: Uint8Array; mime: string }) => Promise<GeneratedCard>>()

// Only the generation seam is mocked, so the real toWebp/putMedia/createCard
// pipeline runs unmocked, exactly like the tts audio route test mocks only
// '@/lib/tts' and leaves the db and card logic real.
vi.mock('@/lib/generate', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generate')>('@/lib/generate')
  return {
    ...actual,
    getGenerator: () => ({ fromImage: fromImageMock, fromPolish: vi.fn(), forms: vi.fn() }),
  }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards, media } = await import('@/lib/db/schema')

const NOW = new Date('2026-09-12T10:00:00')

async function pngFile(name: string, background = { r: 10, g: 120, b: 200 }): Promise<File> {
  const buf = await sharp({ create: { width: 40, height: 30, channels: 3, background } }).png().toBuffer()
  return new File([new Uint8Array(buf)], name, { type: 'image/png' })
}

function post(files: File[]): Promise<Response> {
  const form = new FormData()
  for (const f of files) form.append('images', f)
  return POST(new Request('http://test/api/images', { method: 'POST', body: form }))
}

beforeEach(() => {
  db.delete(cards).run()
  db.delete(media).run()
  fromImageMock.mockReset()
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/images', () => {
  it('400s when no images are provided', async () => {
    const res = await post([])
    expect(res.status).toBe(400)
    expect(db.select().from(cards).all()).toHaveLength(0)
  })

  it('creates one image_to_pl card per image, storing only the re-encoded webp (never the original)', async () => {
    fromImageMock.mockResolvedValueOnce(generated('kot')).mockResolvedValueOnce(generated('pies'))
    const res = await post([await pngFile('cat.png'), await pngFile('dog.png')])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([
      { name: 'cat.png', cardId: expect.any(String), duplicateOf: null, answerPl: 'kot' },
      { name: 'dog.png', cardId: expect.any(String), duplicateOf: null, answerPl: 'pies' },
    ])

    const cardRows = db.select().from(cards).all()
    expect(cardRows).toHaveLength(2)
    for (const c of cardRows) {
      expect(c.type).toBe('image_to_pl')
      expect(c.promptText).toBeNull()
      expect(c.promptMediaId).not.toBeNull()
    }

    // Exactly one media blob per uploaded image — the webp, not the PNG original.
    const mediaRows = db.select().from(media).all()
    expect(mediaRows).toHaveLength(2)
    for (const m of mediaRows) {
      expect(m.mime).toBe('image/webp')
      expect(m.createdAt).toBe(NOW.getTime())
    }
  })

  it('surfaces the existing card as a duplicate instead of creating a second one', async () => {
    fromImageMock.mockResolvedValue(generated('kot'))
    const res = await post([await pngFile('a.png'), await pngFile('b.png')])
    const body = await res.json()
    expect(body.results[0].duplicateOf).toBeNull()
    expect(body.results[1].duplicateOf).toBe(body.results[0].cardId)
    expect(db.select().from(cards).all()).toHaveLength(1)
  })

  it('does not abort the batch when one image fails generation — the others still land as cards', async () => {
    fromImageMock
      .mockResolvedValueOnce(generated('kot'))
      .mockRejectedValueOnce(new Error('generation down'))
      .mockResolvedValueOnce(generated('pies'))
    const res = await post([await pngFile('a.png'), await pngFile('b.png'), await pngFile('c.png')])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(3)
    expect(body.results[0]).toMatchObject({ name: 'a.png', answerPl: 'kot' })
    expect(body.results[1]).toMatchObject({ name: 'b.png' })
    expect(body.results[1].error).toBeTruthy()
    expect(body.results[2]).toMatchObject({ name: 'c.png', answerPl: 'pies' })
    expect(db.select().from(cards).all()).toHaveLength(2)
  })

  it('produces a clean per-file error, not a 500, when sharp cannot decode the upload', async () => {
    fromImageMock.mockResolvedValue(generated('kot'))
    const notAnImage = new File([new Uint8Array([1, 2, 3, 4, 5])], 'not-an-image.jpg', { type: 'image/jpeg' })
    const res = await post([await pngFile('a.png'), notAnImage])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ name: 'a.png', answerPl: 'kot' })
    expect(body.results[1].name).toBe('not-an-image.jpg')
    expect(body.results[1].error).toBeTruthy()
    expect(body.results[1].cardId).toBeUndefined()
    expect(db.select().from(cards).all()).toHaveLength(1)
    // The undecodable file never made it to putMedia.
    expect(db.select().from(media).all()).toHaveLength(1)
  })
})
