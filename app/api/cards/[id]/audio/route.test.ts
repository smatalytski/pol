import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// route.ts imports the real `@/lib/db/client` singleton, which opens a
// sqlite file at process.env.FISZKI_DB on import. Point it at a throwaway
// file instead of the dev db (data/fiszki.db) before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-tts-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

type GetClipArgs = [db: unknown, synth: unknown, text: string, lang: 'pl' | 'ru', now: Date]
const getClipMock = vi.fn<(...args: GetClipArgs) => Promise<string>>(async () => 'media-id-stub')
const getSynthesizerMock = vi.fn(() => ({ synthesize: vi.fn() }))

// Mock only the TTS seam, so we can assert exactly which language the route
// asked for without touching GCP. The db is real (a throwaway file), so the
// route's own card lookup and eligibility logic run unmocked.
vi.mock('@/lib/tts', () => ({
  getClip: (...args: Parameters<typeof getClipMock>) => getClipMock(...args),
  getSynthesizer: () => getSynthesizerMock(),
}))

const { GET } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { newState } = await import('@/lib/scheduler')

const NOW = new Date('2026-09-12T10:00:00')

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
      ...newState(NOW),
      ...overrides,
    })
    .run()
  return overrides.id
}

function call(id: string, part?: string) {
  const url = `http://test/api/cards/${id}/audio${part ? `?part=${part}` : ''}`
  return GET(new Request(url), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  db.delete(cards).run()
  getClipMock.mockClear()
  getSynthesizerMock.mockClear()
})

describe('GET /api/cards/:id/audio', () => {
  it('ru_to_pl prompt is spoken in Russian', async () => {
    seedCard({ id: 'c1', type: 'ru_to_pl', promptText: 'злобный' })
    const res = await call('c1', 'prompt')
    expect(res.status).toBe(307)
    expect(getClipMock).toHaveBeenCalledTimes(1)
    expect(getClipMock.mock.calls[0]?.[3]).toBe('ru')
    expect(getClipMock.mock.calls[0]?.[2]).toBe('злобный')
  })

  it('ru_to_pl answer is spoken in Polish', async () => {
    seedCard({ id: 'c2', type: 'ru_to_pl', answerPl: 'złośliwy' })
    const res = await call('c2', 'answer')
    expect(res.status).toBe(307)
    expect(getClipMock).toHaveBeenCalledTimes(1)
    expect(getClipMock.mock.calls[0]?.[3]).toBe('pl')
    expect(getClipMock.mock.calls[0]?.[2]).toBe('złośliwy')
  })

  // Regression, found in production on a phone. The Location header must not
  // carry the server's own origin. Behind a reverse proxy — `tailscale serve`
  // here, any ingress in general — the internal `req.url` is
  // http://localhost:3000, so an absolute Location built from it told the
  // BROWSER to fetch https://localhost:3000/api/media/..., i.e. the phone's
  // own localhost, where nothing is listening. The <audio> element failed
  // silently: the clip had already been synthesized server-side, so the only
  // symptom was a play button that did nothing and a TTS bill for audio
  // nobody could hear. The three tests above assert `status === 307` and never
  // look at where the redirect points, which is exactly why this shipped.
  it('Location is origin-independent, not the internal request host', async () => {
    seedCard({ id: 'c9', type: 'ru_to_pl', answerPl: 'złośliwy' })
    const res = await GET(
      new Request('http://localhost:3000/api/cards/c9/audio?part=answer'),
      { params: Promise.resolve({ id: 'c9' }) },
    )
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('/api/media/media-id-stub')
  })

  it('rejects an invalid part before touching the card', async () => {
    seedCard({ id: 'c7' })
    const res = await call('c7', 'bogus')
    expect(res.status).toBe(400)
    expect(getClipMock).not.toHaveBeenCalled()
  })

  it('404s for an unknown card id', async () => {
    const res = await call('does-not-exist', 'answer')
    expect(res.status).toBe(404)
    expect(getClipMock).not.toHaveBeenCalled()
  })

  // Spec §8: a pl_to_pl card's prompt IS the Polish word, so "the prompt" is
  // spoken in Polish from answer_pl — never the stored Russian prompt_text.
  it('speaks a pl_to_pl prompt as the Polish word', async () => {
    seedCard({ id: 'f1', type: 'pl_to_pl', promptText: 'кот', answerPl: 'kot' })
    const res = await call('f1', 'prompt')
    expect(res.status).toBe(307)
    expect(getClipMock.mock.calls[0]?.[2]).toBe('kot')
    expect(getClipMock.mock.calls[0]?.[3]).toBe('pl')
  })

  it('speaks a pl_to_pl answer as the Polish word', async () => {
    seedCard({ id: 'f2', type: 'pl_to_pl', answerPl: 'kot' })
    await call('f2', 'answer')
    expect(getClipMock.mock.calls[0]?.[2]).toBe('kot')
    expect(getClipMock.mock.calls[0]?.[3]).toBe('pl')
  })
})
