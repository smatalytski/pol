import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, captures, media } from '../db/schema'
import { deleteCard } from '../cards/service'
import type { Generator, GeneratedCard } from '../generate'
import type { Transcriber } from '../transcribe'
import { createCapture, listCaptures, processCapture, retranscribe } from './pipeline'

const NOW = new Date('2026-09-12T10:00:00')
const AUDIO = { bytes: new Uint8Array([9, 9, 9]), mime: 'audio/webm' }

const GENERATED: GeneratedCard = {
  answer_pl: 'złośliwy',
  prompt_ru: 'злобный',
  prompt_hint: 'прилагательное',
  example_pl: 'Zrobił to ze złośliwości.',
  example_ru: 'Он сделал это из злобы.',
  grammar_note: '',
  kind: 'przymiotnik',
  forms_basic: [{ label: 'przysłówek', value: 'złośliwie' }],
  forms_extended: [],
}

function deps(over: { transcriber?: Partial<Transcriber>; generator?: Partial<Generator> } = {}) {
  const { db } = createTestDb()
  return {
    db,
    transcriber: { transcribe: vi.fn().mockResolvedValue('zloslivy'), ...over.transcriber } as Transcriber,
    generator: {
      fromDictation: vi.fn().mockResolvedValue(GENERATED),
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
    const fromDictation = vi.fn().mockRejectedValueOnce(new Error('llm down')).mockResolvedValue(GENERATED)
    const d = deps({ generator: { fromDictation } })

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
    const d = deps({ generator: { fromDictation: vi.fn().mockRejectedValue(new Error('llm down')) } })
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

  it('stores the kind and forms the generation returned', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBe(GENERATED.kind)
    expect(JSON.parse(card.formsJson!)).toEqual({ basic: GENERATED.forms_basic, extended: GENERATED.forms_extended })
  })

  it('stores no kind and no forms when generation fails', async () => {
    const d = deps({ generator: { fromDictation: vi.fn().mockRejectedValue(new Error('429')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBeNull()
    expect(card.formsJson).toBeNull()
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
    d.generator.fromDictation = vi.fn().mockImplementation(async () => {
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

  // The chip offers the type switch only once generation has classified the
  // word as one with forms, so it needs the card's type and kind.
  it('exposes the card type and word kind of each capture', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW)
    const [view] = listCaptures(d.db, 0)
    expect(view.cardType).toBe('ru_to_pl')
    expect(view.wordKind).toBe(GENERATED.kind)
  })
})

// Polish and Russian share too many near-homophones for a two-language
// recognizer to be safe: measured on the real API, spoken "склеп" came back
// "sklep" and "бешенство" came back "wściekłość". So dictation stays Polish
// and a Russian recording is fixed afterwards — which only works from the
// stored audio, since the wrong transcript carries no trace of what was said.
describe('retranscribe', () => {
  const RU_GENERATED: GeneratedCard = {
    answer_pl: 'krypta',
    prompt_ru: 'склеп',
    prompt_hint: '',
    example_pl: 'Krypta pod kościołem.',
    example_ru: 'Склеп под церковью.',
    grammar_note: 'rzeczownik rodzaju żeńskiego',
    kind: 'rzeczownik',
    forms_basic: [{ label: 'M. l.mn.', value: 'krypty' }],
    forms_extended: [],
  }

  function strandedInPolish() {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    return { d, id }
  }

  it('re-recognises the stored audio in the requested language', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)

    await retranscribe(d, id, 'ru', NOW)

    const call = (d.transcriber.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.lang).toBe('ru')
    // getMedia hands back a sqlite Buffer, so compare contents not classes.
    expect(Array.from(call.bytes as Uint8Array)).toEqual(Array.from(AUDIO.bytes))
    expect(d.db.select().from(captures).where(eq(captures.id, id)).get()!.transcript).toBe('склеп')
  })

  it('rewrites the capture existing card in place instead of making a second one', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    const before = d.db.select().from(cards).get()!
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)

    await retranscribe(d, id, 'ru', NOW)

    const all = d.db.select().from(cards).all()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(before.id)
    expect(all[0].promptText).toBe('склеп')
    expect(all[0].answerPl).toBe('krypta')
    expect(all[0].answerKey).toBe('krypta')
    expect(all[0].grammarNote).toBe('rzeczownik rodzaju żeńskiego')
  })

  it('creates a card when the capture never got one', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('nope')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await processCapture(d, id, NOW) // transcription failed: no card
    expect(d.db.select().from(cards).all()).toHaveLength(0)

    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)
    await retranscribe(d, id, 'ru', NOW)

    const card = d.db.select().from(cards).get()!
    expect(card.answerPl).toBe('krypta')
    expect(d.db.select().from(captures).where(eq(captures.id, id)).get()!.cardId).toBe(card.id)
  })

  // The re-recognised answer re-keys the card, so it can land on a word that
  // is already in the deck. Forking the deck into two cards sharing one
  // answer_key is worse than keeping this card's answer and saying so.
  it('keeps the answer and reports the clash when the new answer already exists', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    // A second, unrelated card already owns "krypta".
    const other = createCapture(d.db, { bytes: new Uint8Array([7]), mime: 'audio/webm' }, NOW)
    d.generator.fromDictation = vi.fn().mockResolvedValue({ ...RU_GENERATED, prompt_ru: 'могила' })
    d.transcriber.transcribe = vi.fn().mockResolvedValue('могила')
    await processCapture(d, other, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(2)

    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)
    const { duplicateOf } = await retranscribe(d, id, 'ru', NOW)

    const fixed = d.db.select().from(cards).where(eq(cards.id, d.db.select().from(captures).where(eq(captures.id, id)).get()!.cardId!)).get()!
    expect(duplicateOf).not.toBeNull()
    expect(fixed.answerPl).toBe('złośliwy') // untouched
    expect(fixed.promptText).toBe('склеп') // prompt still written
    expect(d.db.select().from(cards).all()).toHaveLength(2)
  })

  it('records the failure and leaves the card alone when re-recognition fails', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockRejectedValue(new Error('unintelligible'))

    await retranscribe(d, id, 'ru', NOW)

    const capture = d.db.select().from(captures).where(eq(captures.id, id)).get()!
    expect(capture.error).toMatch(/unintelligible/)
    // The old transcript and card survive, so the button can be pressed again.
    expect(capture.transcript).toBe('zloslivy')
    expect(d.db.select().from(cards).get()!.answerPl).toBe('złośliwy')
  })

  // A media row cannot be deleted out from under a capture — captures
  // .audio_media_id is a foreign key, and deleting the media first fails with
  // FOREIGN KEY constraint failed. So the reachable "no audio" case is a
  // capture that never had any, which is what this covers.
  // The caller needs the failure in the response, not only recorded on the
  // capture row: the card detail screen never polls captures, so without this
  // a failed re-recognition there would look exactly like a success.
  it('returns the failure so the caller can show it without polling', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockRejectedValue(new Error('unintelligible'))

    const { error } = await retranscribe(d, id, 'ru', NOW)

    expect(error).toMatch(/unintelligible/)
  })

  it('returns no error when it worked', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)

    expect((await retranscribe(d, id, 'ru', NOW)).error).toBeNull()
  })

  // Found by running this end to end against the real providers: recognition
  // succeeded, Gemini answered 429, and the card was left answer_pl="склеп",
  // prompt_text=null, status="ready" — a card with no question at all, queued
  // for review. processCapture's create path has always fallen back to
  // needs_input; the update path here has to as well. That also hands the card
  // to `wygeneruj ponownie`, which only accepts needs_input and regenerates
  // from answer_pl — now the Cyrillic transcript, which fromDictation reads
  // correctly.
  it('replaces the kind and forms when it rebuilds the card', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockResolvedValue(RU_GENERATED)
    await retranscribe(d, id, 'ru', NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBe(RU_GENERATED.kind)
    expect(JSON.parse(card.formsJson!).basic).toEqual(RU_GENERATED.forms_basic)
  })

  it('marks the card needs_input when re-recognition works but generation fails', async () => {
    const { d, id } = strandedInPolish()
    await processCapture(d, id, NOW)
    expect(d.db.select().from(cards).get()!.status).toBe('ready')

    d.transcriber.transcribe = vi.fn().mockResolvedValue('склеп')
    d.generator.fromDictation = vi.fn().mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'))
    const { error } = await retranscribe(d, id, 'ru', NOW)

    const card = d.db.select().from(cards).get()!
    expect(error).toMatch(/429/)
    expect(card.answerPl).toBe('склеп')
    expect(card.promptText).toBeNull()
    expect(card.status).toBe('needs_input')
  })

  it('refuses a capture that has no audio to re-recognise', async () => {
    const d = deps()
    d.db
      .insert(captures)
      .values({
        id: 'no-audio',
        audioMediaId: null,
        transcript: null,
        status: 'uploaded',
        error: null,
        generationJson: null,
        cardId: null,
        createdAt: NOW.getTime(),
      })
      .run()

    await retranscribe(d, 'no-audio', 'ru', NOW)

    expect(d.db.select().from(captures).where(eq(captures.id, 'no-audio')).get()!.error).toMatch(/audio/)
    expect(d.transcriber.transcribe).not.toHaveBeenCalled()
  })
})
