import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-jezyk-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const transcribeMock = vi.fn().mockResolvedValue('склеп')
const fromDictationMock = vi.fn().mockResolvedValue({
  answer_pl: 'krypta',
  prompt_ru: 'склеп',
  prompt_hint: '',
  example_pl: 'Krypta pod kościołem.',
  example_ru: 'Склеп под церковью.',
  grammar_note: 'rzeczownik',
})

vi.mock('@/lib/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transcribe')>()
  return { ...actual, getTranscriber: () => ({ transcribe: transcribeMock }) }
})
vi.mock('@/lib/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generate')>()
  return { ...actual, getGenerator: () => ({ ...actual.getGenerator(), fromDictation: fromDictationMock }) }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures, cards, media } = await import('@/lib/db/schema')
const { createCapture } = await import('@/lib/capture/pipeline')

const NOW = new Date('2026-09-12T10:00:00')

function post(id: string, body: unknown) {
  return POST(
    new Request(`http://test/api/captures/${id}/jezyk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  db.delete(captures).run()
  db.delete(cards).run()
  db.delete(media).run()
  transcribeMock.mockClear()
  fromDictationMock.mockClear()
})

describe('POST /api/captures/:id/jezyk', () => {
  it('re-recognises the audio in the requested language', async () => {
    const id = createCapture(db, { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/webm' }, NOW)
    const res = await post(id, { lang: 'ru' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(transcribeMock.mock.calls[0][0].lang).toBe('ru')
    expect(body.error).toBeNull()
    expect(body.cardId).toBeTruthy()
    expect(db.select().from(captures).get()!.transcript).toBe('склеп')
  })

  it('rejects a language it does not support, rather than guessing', async () => {
    const id = createCapture(db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, NOW)
    const res = await post(id, { lang: 'de' })
    expect(res.status).toBe(400)
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  // Re-recognition talks to Speech-to-Text and Gemini, so it fails the way
  // every other provider call in this app fails. The response has to carry
  // that, because the card detail screen does not poll capture rows.
  it('reports a failed re-recognition in the response', async () => {
    const id = createCapture(db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, NOW)
    transcribeMock.mockRejectedValueOnce(new Error('transcription failed: unintelligible'))
    const res = await post(id, { lang: 'ru' })
    expect(res.status).toBe(200)
    expect((await res.json()).error).toMatch(/unintelligible/)
  })
})
