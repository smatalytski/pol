import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, captures, media } from '../db/schema'
import { deleteCard } from '../cards/service'
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
    const mediaRows = d.db.select().from(media).all()
    expect(mediaRows).toHaveLength(1)
    // The media row must be stamped with the injected clock, not the wall clock: createCapture
    // receives `now` specifically so every timestamp it writes is deterministic under test.
    expect(mediaRows[0].createdAt).toBe(NOW.getTime())
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

  it('surfaces a duplicate across a needs_input/ready pair via the transcript-key fallback', async () => {
    // First dictation: generation is down, so the card is keyed by the raw transcript
    // ('zloslivy') and lands needs_input. Second dictation of the SAME word: generation
    // succeeds and would key the card by the restored 'złośliwy' — a different string — so
    // the primary answer-key lookup alone would miss the first card entirely and silently
    // fork the word into a second, orphaning the first.
    const fromPolish = vi.fn().mockRejectedValueOnce(new Error('llm down')).mockResolvedValue(GENERATED)
    const d = deps({ generator: { fromPolish } })

    const first = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, first, NOW)
    const firstCard = d.db.select().from(cards).get()!
    expect(firstCard.status).toBe('needs_input')
    expect(firstCard.answerKey).toBe('zloslivy')

    const second = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, second, NOW)

    expect(d.db.select().from(cards).all()).toHaveLength(1)
    const view = listCaptures(d.db, 0).find((c) => c.id === second)!
    expect(view.duplicateOf).toBe(firstCard.id)
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

  // Critical race from review: DELETE /api/captures/:id (swipe-to-delete on a
  // chip with no card yet) can land while this exact function is mid-flight —
  // transcription has already landed (status: 'transcribed', set BEFORE this
  // await) when the word turns out to be wrong, which is precisely when a
  // user is most likely to swipe. Without a re-check, `createCard` below
  // still runs after the capture row is gone, producing a live, reviewable
  // card for a capture the user just told the app to forget — and the chip
  // never comes back, since /dodaj only requests captures from the last 60s.
  it('creates no card if the capture is deleted while generation is in flight (simulates a mid-pipeline swipe-delete)', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    // Overriding the mock after construction, rather than passing it into
    // `deps()`, so the mock's closure can reference `id` without a `var`
    // hoisting trick.
    d.generator.fromPolish = vi.fn().mockImplementation(async () => {
      // The user swiped the chip away right as generation was in flight —
      // exactly the window this test exercises.
      d.db.delete(captures).where(eq(captures.id, id)).run()
      return GENERATED
    })

    await processCapture(d, id, NOW)

    expect(d.db.select().from(cards).all()).toHaveLength(0)
    expect(d.db.select().from(captures).where(eq(captures.id, id)).all()).toHaveLength(0)
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

  // Important review finding (A4): swipe-to-delete on a finished chip
  // soft-deletes its card, not its capture row. Without filtering here, the
  // chip stayed on screen looking undeleted — and /dodaj's `since` cursor is
  // pinned at mount, so it would never age out on its own.
  it('omits a capture whose card has been soft-deleted', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const view = listCaptures(d.db, 0).find((c) => c.id === id)!
    expect(view.cardId).not.toBeNull()

    deleteCard(d.db, view.cardId!, NOW)
    expect(listCaptures(d.db, 0).find((c) => c.id === id)).toBeUndefined()
  })

  it('keeps a capture with no card at all (nothing to soft-delete)', () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    expect(listCaptures(d.db, 0).find((c) => c.id === id)).toBeDefined()
  })
})
