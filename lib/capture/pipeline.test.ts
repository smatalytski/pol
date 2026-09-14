import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, captures, media } from '../db/schema'
import type { Generator } from '../generate'
import type { Transcriber } from '../transcribe'
import { createCapture, listCaptures, processCapture } from './pipeline'

const NOW = new Date('2026-09-12T10:00:00')
const AUDIO = { bytes: new Uint8Array([9, 9, 9]), mime: 'audio/webm' }

const GENERATED = {
  answer_pl: 'złośliwy',
  prompt_ru: 'злобный',
  prompt_hint: 'прилагательное',
  example_pl: 'Zrobił to ze złośliwości.',
  example_ru: 'Он сделал это из злобы.',
  grammar_note: '',
}

function deps(over: { transcriber?: Partial<Transcriber>; generator?: Partial<Generator> } = {}) {
  const { db } = createTestDb()
  return {
    db,
    transcriber: { transcribe: vi.fn().mockResolvedValue('zloslivy'), ...over.transcriber } as Transcriber,
    generator: {
      fromPolish: vi.fn().mockResolvedValue(GENERATED),
      fromImage: vi.fn(),
      forms: vi.fn(),
      ...over.generator,
    } as Generator,
  }
}

describe('createCapture', () => {
  it('stores the audio and a pending capture before anything else can fail', () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    const row = d.db.select().from(captures).where(eq(captures.id, id)).get()!
    expect(row.status).toBe('uploaded')
    expect(row.audioMediaId).not.toBeNull()
    expect(d.db.select().from(media).all()).toHaveLength(1)
  })
})

describe('processCapture', () => {
  it('creates a ready card from the generated fields', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)

    const card = d.db.select().from(cards).get()!
    expect(card.type).toBe('ru_to_pl')
    expect(card.status).toBe('ready')
    expect(card.answerPl).toBe('złośliwy')
    expect(card.promptText).toBe('злобный')
    expect(card.answerKey).toBe('złośliwy')
    expect(card.grammarNote).toBeNull()
    expect(card.state).toBe(0)

    const capture = d.db.select().from(captures).where(eq(captures.id, id)).get()!
    expect(capture.status).toBe('generated')
    expect(capture.transcript).toBe('zloslivy')
    expect(capture.cardId).toBe(card.id)
  })

  it('keys the card off the NORMALIZED Polish answer, not the raw transcript', async () => {
    const d = deps()
    await processCapture(d, createCapture(d.db, AUDIO, NOW), NOW)
    expect(d.db.select().from(cards).get()!.answerKey).toBe('złośliwy')
  })

  it('surfaces a duplicate instead of creating a second card', async () => {
    const d = deps()
    await processCapture(d, createCapture(d.db, AUDIO, NOW), NOW)
    const second = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, second, NOW)

    expect(d.db.select().from(cards).all()).toHaveLength(1)
    const view = listCaptures(d.db, 0).find((c) => c.id === second)!
    expect(view.duplicateOf).toBe(d.db.select().from(cards).get()!.id)
    expect(view.status).toBe('generated')
  })

  it('keeps the audio and allows retry when transcription fails', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('stt down')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)

    const row = d.db.select().from(captures).where(eq(captures.id, id)).get()!
    expect(row.status).toBe('failed')
    expect(row.error).toContain('stt down')
    expect(row.audioMediaId).not.toBeNull()
    expect(d.db.select().from(media).all()).toHaveLength(1)
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('still creates a card when generation fails, flagged needs_input', async () => {
    const d = deps({ generator: { fromPolish: vi.fn().mockRejectedValue(new Error('llm down')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)

    const card = d.db.select().from(cards).get()!
    expect(card.status).toBe('needs_input')
    expect(card.answerPl).toBe('zloslivy')
    expect(card.promptText).toBeNull()
    const row = d.db.select().from(captures).where(eq(captures.id, id)).get()!
    expect(row.cardId).toBe(card.id)
    expect(row.error).toContain('llm down')
  })

  it('retrying a failed capture creates exactly one card', async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('stt down'))
      .mockResolvedValue('zloslivy')
    const d = deps({ transcriber: { transcribe } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    await processCapture(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(captures).where(eq(captures.id, id)).get()!.status).toBe('generated')
  })

  it('is a no-op on a capture that already produced a card', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    await processCapture(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.transcriber.transcribe).toHaveBeenCalledTimes(1)
  })
})

describe('listCaptures', () => {
  it('returns captures newer than the cursor, newest first', () => {
    const d = deps()
    const older = createCapture(d.db, AUDIO, new Date(NOW.getTime() - 10_000))
    const newer = createCapture(d.db, AUDIO, NOW)
    expect(listCaptures(d.db, 0).map((c) => c.id)).toEqual([newer, older])
    expect(listCaptures(d.db, NOW.getTime() - 5_000).map((c) => c.id)).toEqual([newer])
  })
})
