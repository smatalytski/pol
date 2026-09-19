import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cards, captures, generationJobs, media, topicItems, topics } from '../db/schema'
import { createCard, deleteCard, type CreateCardInput } from '../cards/service'
import { GenerationError, type Generator, type GeneratedCard } from '../generate'
import type { Transcriber } from '../transcribe'
import { enqueueJob } from '../queue/jobs'
import { DEFAULT_TOPIC_ID } from '../topics/default'
import {
  createCapture, recognizeCapture, recognizeStranded, listOnScreen, pendingCaptures, knownCardFor,
  generateNewCard, giveUpNewCard, jobHandlers,
} from './pipeline'

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

const input = (over: Partial<CreateCardInput> = {}): CreateCardInput => ({
  type: 'ru_to_pl',
  promptText: 'злобный',
  promptHint: null,
  answerPl: 'złośliwy',
  examplePl: null,
  exampleRu: null,
  grammarNote: null,
  wordKind: null,
  formsJson: null,
  status: 'ready',
  ...over,
})

function deps(over: { transcriber?: Partial<Transcriber>; generator?: Partial<Generator> } = {}) {
  const { db } = createTestDb()
  return {
    db,
    transcriber: { transcribe: vi.fn().mockResolvedValue('zloslivy'), ...over.transcriber } as Transcriber,
    clock: () => NOW,
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

async function recognized(d: ReturnType<typeof deps>, transcript: string, now = NOW) {
  d.transcriber.transcribe = vi.fn().mockResolvedValue(transcript)
  const id = createCapture(d.db, AUDIO, now)
  await recognizeCapture(at(d, now), id)
  return id
}

/** The same deps with the clock stopped at `now`. */
const at = <D extends { clock: () => Date }>(d: D, now: Date): D => ({ ...d, clock: () => now })

const row = (d: ReturnType<typeof deps>, id: string) =>
  d.db.select().from(captures).where(eq(captures.id, id)).get()!

function insertCapture(d: ReturnType<typeof deps>, over: Partial<typeof captures.$inferInsert> & { id: string }) {
  d.db.insert(captures).values({
    audioMediaId: null, transcript: null, status: 'uploaded', error: null, generationJson: null,
    cardId: null, createdAt: NOW.getTime(), transcribedAt: null, duplicateOf: null, ...over,
  }).run()
}

describe('recognizeCapture', () => {
  it('stores the transcript and opens the review window', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    expect(row(d, id)).toMatchObject({ status: 'transcribed', transcript: 'złośliwy', transcribedAt: NOW.getTime(), duplicateOf: null })
  })

  // Spec §3: the window starts when the transcript arrives, not when the
  // request did — Speech-to-Text can take seconds of the 10.
  it('stamps transcribedAt with the clock read after Speech-to-Text returned', async () => {
    const d = deps()
    let clockNow = NOW
    const afterStt = new Date(NOW.getTime() + 3_000)
    d.transcriber.transcribe = vi.fn(async () => {
      clockNow = afterStt
      return 'kot'
    })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture({ ...d, clock: () => clockNow }, id)
    expect(row(d, id).transcribedAt).toBe(afterStt.getTime())
  })

  it('makes no Gemini call — generation is queued, not run here', async () => {
    const d = deps()
    await recognized(d, 'złośliwy')
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('keeps the audio and marks failed when recognition fails', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('unintelligible')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture(d, id)
    expect(row(d, id)).toMatchObject({ status: 'failed', error: 'unintelligible' })
    expect(row(d, id).audioMediaId).not.toBeNull()
    expect(d.db.select().from(media).all()).toHaveLength(1)
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('writes nothing for a recording rejected while Speech-to-Text ran', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW)
    d.transcriber.transcribe = vi.fn(async () => {
      d.db.delete(captures).where(eq(captures.id, id)).run()
      return 'kot'
    })
    await recognizeCapture(d, id)
    expect(d.db.select().from(captures).all()).toHaveLength(0)
  })

  it('flags a word already in the deck as już masz', async () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    const id = await recognized(d, 'Kot.')
    expect(row(d, id).duplicateOf).toBe(cardId)
  })

  it('retries a failed recognition, and the recording then yields exactly one card', async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('stt down')).mockResolvedValue('zloslivy')
    const d = deps({ transcriber: { transcribe } })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture(d, id)
    expect(row(d, id).status).toBe('failed')
    await recognizeCapture(d, id)
    expect(row(d, id)).toMatchObject({ status: 'transcribed', transcript: 'zloslivy', error: null })
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(row(d, id).status).toBe('generated')
  })

  it('does not re-recognise a recording that is past recognition', async () => {
    const d = deps()
    const id = await recognized(d, 'zloslivy')
    await generateNewCard(d, id, NOW)
    await recognizeCapture(d, id)
    expect(d.transcriber.transcribe).toHaveBeenCalledTimes(1)
    expect(row(d, id).status).toBe('generated')
  })

  it('marks a recording with no audio failed without calling Speech-to-Text', async () => {
    const d = deps()
    insertCapture(d, { id: 'no-audio' })
    await recognizeCapture(d, 'no-audio')
    expect(row(d, 'no-audio')).toMatchObject({ status: 'failed', error: 'no audio' })
    expect(d.transcriber.transcribe).not.toHaveBeenCalled()
  })
})

describe('knownCardFor', () => {
  it('matches a Latin transcript on the answer key', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'wścieklizna' }), NOW)
    expect(knownCardFor(d.db, 'Wścieklizna!')).toBe(cardId)
  })

  it('matches a Cyrillic transcript on the Russian prompt', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'grobowiec', promptText: 'склеп' }), NOW)
    expect(knownCardFor(d.db, 'Склеп.')).toBe(cardId)
  })

  // Spec §4: best-effort by design. answerKey never strips diacritics, so a
  // transcript that lost one does not match — the generation-time dedup
  // catches it instead.
  it('misses a transcript that lost a diacritic', () => {
    const d = deps()
    createCard(d.db, input({ answerPl: 'wścieklizna' }), NOW)
    expect(knownCardFor(d.db, 'wscieklizna')).toBeNull()
  })

  it('ignores deleted cards and pl_to_pl cards', () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    deleteCard(d.db, cardId, NOW)
    createCard(d.db, input({ answerPl: 'pies', type: 'pl_to_pl' }), NOW)
    expect(knownCardFor(d.db, 'kot')).toBeNull()
    expect(knownCardFor(d.db, 'pies')).toBeNull()
  })
})

describe('listOnScreen', () => {
  it('shows a recording under review with its remaining time, then drops it when approved', async () => {
    const d = deps()
    const id = await recognized(d, 'kot')
    const at4s = new Date(NOW.getTime() + 4_000)
    expect(listOnScreen(d.db, 0, at4s)).toEqual([
      expect.objectContaining({ id, inReview: true, reviewRemainingMs: 6_000 }),
    ])
    expect(listOnScreen(d.db, 0, new Date(NOW.getTime() + 10_000))).toEqual([])
  })

  it('keeps a failed recognition on screen until acted on', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValue(new Error('x')) } })
    const id = createCapture(d.db, AUDIO, NOW)
    await recognizeCapture(d, id)
    expect(listOnScreen(d.db, 0, new Date(NOW.getTime() + 60_000))).toEqual([
      expect.objectContaining({ id, status: 'failed', inReview: false, reviewRemainingMs: null }),
    ])
  })

  it('shows at most the 5 newest recordings under review', async () => {
    const d = deps()
    for (let i = 0; i < 6; i++) await recognized(d, `w${i}`, new Date(NOW.getTime() + i))
    const shown = listOnScreen(d.db, 0, new Date(NOW.getTime() + 10))
    expect(shown.map((c) => c.transcript)).toEqual(['w5', 'w4', 'w3', 'w2', 'w1'])
  })

  it('returns uploaded recordings newer than the cursor, newest first', () => {
    const d = deps()
    const older = createCapture(d.db, AUDIO, new Date(NOW.getTime() - 10_000))
    const newer = createCapture(d.db, AUDIO, NOW)
    expect(listOnScreen(d.db, 0, NOW).map((c) => c.id)).toEqual([newer, older])
    expect(listOnScreen(d.db, NOW.getTime() - 5_000, NOW).map((c) => c.id)).toEqual([newer])
    expect(listOnScreen(d.db, 0, NOW)[0]).toMatchObject({ status: 'uploaded', inReview: false, reviewRemainingMs: null })
  })

  // A recording with a card is never on the recording screen, so a card
  // soft-deleted from a chip cannot leave the chip standing.
  it('never shows a recording that has become a card', async () => {
    const d = deps()
    const id = await recognized(d, 'kot')
    await generateNewCard(d, id, NOW)
    expect(listOnScreen(d.db, 0, NOW)).toEqual([])
  })

  it('takes już masz from the recording, not from the generation', async () => {
    const d = deps()
    const { cardId } = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    const id = await recognized(d, 'kot')
    expect(listOnScreen(d.db, 0, NOW)).toEqual([expect.objectContaining({ id, duplicateOf: cardId })])
  })
})

describe('generateNewCard', () => {
  it('creates a ready card from the transcript and records it on the recording', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    await generateNewCard(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card).toMatchObject({ status: 'ready', answerPl: GENERATED.answer_pl, wordKind: GENERATED.kind })
    expect(row(d, id)).toMatchObject({ status: 'generated', cardId: card.id, error: null })
  })

  it('builds the card from the generated fields, keyed by the generated answer', async () => {
    const d = deps()
    const id = await recognized(d, 'zloslivy')
    await generateNewCard(d, id, NOW)
    const card = d.db.select().from(cards).get()!
    expect(card).toMatchObject({
      type: 'ru_to_pl', status: 'ready', answerPl: 'złośliwy', promptText: 'злобный',
      answerKey: 'złośliwy', grammarNote: null, state: 0,
    })
    expect(row(d, id).transcript).toBe('zloslivy')
  })

  it('stores the kind and forms the generation returned', async () => {
    const d = deps()
    await generateNewCard(d, await recognized(d, 'zloslivy'), NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.wordKind).toBe(GENERATED.kind)
    expect(JSON.parse(card.formsJson!)).toEqual({ basic: GENERATED.forms_basic, extended: GENERATED.forms_extended })
  })

  it('dedups a second recording of the same word onto the first card', async () => {
    const d = deps()
    const a = await recognized(d, 'zloslivy')
    await generateNewCard(d, a, NOW)
    const b = await recognized(d, 'zloslivy', new Date(NOW.getTime() + 1))
    await generateNewCard(d, b, NOW)
    const all = d.db.select().from(cards).all()
    expect(all).toHaveLength(1)
    expect(row(d, b)).toMatchObject({ status: 'generated', cardId: all[0].id })
    expect(JSON.parse(row(d, b).generationJson!).duplicateOf).toBe(all[0].id)
  })

  // The first recording's job gave up, so its card is keyed by the raw
  // transcript ('zloslivy'); the second generates 'złośliwy' — a different
  // key — and only the fallback finds it.
  it('dedups onto a needs_input card via the transcript-key fallback', async () => {
    const d = deps()
    const a = await recognized(d, 'zloslivy')
    giveUpNewCard(d.db, a, 'llm down', NOW)
    const first = d.db.select().from(cards).get()!
    expect(first).toMatchObject({ status: 'needs_input', answerKey: 'zloslivy' })
    const b = await recognized(d, 'zloslivy', new Date(NOW.getTime() + 1))
    await generateNewCard(d, b, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(row(d, b).cardId).toBe(first.id)
    expect(JSON.parse(row(d, b).generationJson!).duplicateOf).toBe(first.id)
  })

  it('throws a generation failure for the queue to handle, creating nothing', async () => {
    const d = deps({ generator: { fromDictation: vi.fn().mockRejectedValue(new GenerationError('429', { retryable: true })) } })
    const id = await recognized(d, 'złośliwy')
    await expect(generateNewCard(d, id, NOW)).rejects.toThrow('429')
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('creates nothing for a recording deleted while Gemini ran', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    d.generator.fromDictation = vi.fn(async () => {
      d.db.delete(captures).where(eq(captures.id, id)).run()
      return GENERATED
    })
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(0)
  })

  it('is idempotent — a recording that already has a card makes no second one', async () => {
    const d = deps()
    const id = await recognized(d, 'złośliwy')
    await generateNewCard(d, id, NOW)
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.generator.fromDictation).toHaveBeenCalledTimes(1)
  })

  // Ruling 3: a crash after the card was created but before the job was
  // marked done re-runs the job with the recording still 'generating'; it
  // must not stay pending forever.
  it('marks a recording that already has a card generated without calling Gemini', async () => {
    const d = deps()
    const { cardId } = createCard(d.db, input(), NOW)
    insertCapture(d, { id: 'c1', transcript: 'zloslivy', status: 'generating', cardId, transcribedAt: NOW.getTime() })
    await generateNewCard(d, 'c1', NOW)
    expect(row(d, 'c1')).toMatchObject({ status: 'generated', cardId })
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
  })
})

describe('giveUpNewCard', () => {
  it('keeps the word as a needs_input card with the last error', async () => {
    const d = deps()
    const id = await recognized(d, 'Zdrów jak ryba.')
    giveUpNewCard(d.db, id, 'unusable payload', NOW)
    const card = d.db.select().from(cards).get()!
    expect(card).toMatchObject({ status: 'needs_input', answerPl: 'Zdrów jak ryba.', promptText: null, wordKind: null })
    expect(card.formsJson).toBeNull()
    expect(row(d, id)).toMatchObject({ status: 'generated', cardId: card.id, error: 'unusable payload' })
  })
})

describe('jobHandlers', () => {
  it('has a handler for exactly the three job kinds', () => {
    const h = jobHandlers({ ...deps(), suggester: { suggest: vi.fn() } })
    expect(Object.keys(h).sort()).toEqual(['new', 'regenerate', 'suggest'])
  })

  it('wires each job kind to its body', async () => {
    const d = deps()
    const h = jobHandlers({ ...d, suggester: { suggest: vi.fn() } })
    const id = await recognized(d, 'zloslivy')
    const job = (kind: 'new' | 'regenerate', over: { captureId?: string; cardId?: string } = {}) => {
      const jobId = enqueueJob(d.db, { kind, ...over }, NOW)
      return d.db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).get()!
    }

    await h.new.run(job('new', { captureId: id }), NOW)
    const card = d.db.select().from(cards).get()!
    expect(row(d, id).cardId).toBe(card.id)

    const stranded = createCard(d.db, input({ answerPl: 'zdrow', status: 'needs_input', promptText: null }), NOW)
    d.generator.fromDictation = vi.fn().mockResolvedValue(GENERATED)
    await h.regenerate.run(job('regenerate', { cardId: stranded.cardId }), NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('zdrow')

    const b = await recognized(d, 'pies', new Date(NOW.getTime() + 1))
    h.new.giveUp(job('new', { captureId: b }), 'dead', NOW)
    expect(row(d, b)).toMatchObject({ status: 'generated', error: 'dead' })
  })
})

describe('jobHandlers regenerate', () => {
  // wygeneruj ponownie was queued for a card that has since been deleted or
  // repaired: there is nothing to do, and throwing would burn three attempts
  // and show generowanie… for a card nothing is rewriting.
  it('does nothing for a card deleted or no longer needs_input', async () => {
    const d = deps()
    const h = jobHandlers({ ...d, suggester: { suggest: vi.fn() } })
    const gone = createCard(d.db, input({ answerPl: 'zdrow', status: 'needs_input', promptText: null }), NOW)
    deleteCard(d.db, gone.cardId, NOW)
    const repaired = createCard(d.db, input({ answerPl: 'kot' }), NOW)
    for (const cardId of [gone.cardId, repaired.cardId]) {
      const jobId = enqueueJob(d.db, { kind: 'regenerate', cardId }, NOW)
      const job = d.db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).get()!
      await expect(h.regenerate.run(job, NOW)).resolves.toBeUndefined()
    }
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
  })
})

// A deploy is a restart: a recording uploaded just before it never gets the
// recognition its request started, and would sit at rozpoznawanie… forever.
describe('recognizeStranded', () => {
  it('recognises every recording left uploaded, oldest first, and keeps going past an error', async () => {
    const d = deps()
    const a = createCapture(d.db, AUDIO, NOW)
    const b = createCapture(d.db, AUDIO, new Date(NOW.getTime() + 1))
    const c = createCapture(d.db, AUDIO, new Date(NOW.getTime() + 2))
    insertCapture(d, { id: 'failed', status: 'failed', error: 'x' })
    const later = new Date(NOW.getTime() + 60_000)
    d.transcriber.transcribe = vi.fn(async () => {
      // b vanishes between the listing and its turn, so recognising it throws.
      d.db.delete(captures).where(eq(captures.id, b)).run()
      return 'kot'
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await recognizeStranded(at(d, later))
      expect(row(d, a)).toMatchObject({ status: 'transcribed', transcribedAt: later.getTime() })
      expect(row(d, c)).toMatchObject({ status: 'transcribed', transcribedAt: later.getTime() })
      expect(row(d, 'failed')).toMatchObject({ status: 'failed' })
      expect(d.transcriber.transcribe).toHaveBeenCalledTimes(2)
      expect(errors).toHaveBeenCalledWith(expect.any(String), b, expect.any(Error))
    } finally {
      errors.mockRestore()
    }
  })
})

describe('pendingCaptures', () => {
  it('lists recordings waiting for or in generation, newest first', () => {
    const d = deps()
    for (const [id, status, t] of [['q', 'queued', 1], ['g', 'generating', 2], ['x', 'generated', 3]] as const) {
      d.db.insert(captures).values({
        id, audioMediaId: null, transcript: id, status, error: null, generationJson: null,
        cardId: null, createdAt: t, transcribedAt: t, duplicateOf: null,
      }).run()
    }
    expect(pendingCaptures(d.db)).toEqual([
      { id: 'g', transcript: 'g', status: 'generating' },
      { id: 'q', transcript: 'q', status: 'queued' },
    ])
  })
})

describe('recognition language (spec 2026-09-18-recording-language §2)', () => {
  it('stores the language the recording was made in', () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    expect(row(d, id).lang).toBe('ru')
  })

  it('stores pl when no language is given', () => {
    const d = deps()
    expect(row(d, createCapture(d.db, AUDIO, NOW)).lang).toBe('pl')
  })

  it('recognises in the stored language', async () => {
    const d = deps()
    const ru = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeCapture(d, ru)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))
    const pl = createCapture(d.db, AUDIO, NOW, 'pl')
    await recognizeCapture(d, pl)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'pl' }))
  })

  it('recognises an older recording, with no stored language, as Polish', async () => {
    const d = deps()
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    d.db.update(captures).set({ lang: null }).where(eq(captures.id, id)).run()
    await recognizeCapture(d, id)
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'pl' }))
  })

  it('keeps the language when a failed recognition is retried, and after a restart', async () => {
    const d = deps({ transcriber: { transcribe: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('склеп') } })
    const id = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeCapture(d, id)
    expect(row(d, id).status).toBe('failed')
    await recognizeCapture(d, id) // ponów
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))

    const stranded = createCapture(d.db, AUDIO, NOW, 'ru')
    await recognizeStranded(d)
    expect(row(d, stranded).status).toBe('transcribed')
    expect(d.transcriber.transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ru' }))
  })
})

describe('a topic item becoming a card', () => {
  /**
   * What `+ karta` leaves behind (spec 2026-09-19-topic-items §4.1): a
   * `carded` item pointing at a queued, audio-less capture.
   */
  function accepted(
    d: ReturnType<typeof deps>,
    over: { topicId?: string; glossRu?: string | null } = {},
  ) {
    const topicId = over.topicId ?? 't1'
    const glossRu = over.glossRu === undefined ? 'злобный' : over.glossRu
    if (topicId !== DEFAULT_TOPIC_ID) {
      d.db.insert(topics).values({
        id: topicId, name: null, context: 'u lekarza z dzieckiem', suspendedAt: null, createdAt: NOW.getTime(), isDefault: false,
      }).run()
    }
    const captureId = 'c-item'
    d.db.insert(captures).values({
      id: captureId, audioMediaId: null, transcript: 'złośliwy', status: 'queued', error: null, generationJson: null,
      cardId: null, createdAt: NOW.getTime(), transcribedAt: null, duplicateOf: null, topicId, glossRu,
    }).run()
    d.db.insert(topicItems).values({
      id: 'i1', topicId, answerPl: 'złośliwy', glossRu, kind: glossRu ? 'slowo' : null,
      source: glossRu ? 'suggested' : 'manual', level: glossRu ? 'zaawansowany' : null, status: 'carded',
      captureId, cardId: null, batchJobId: null, discardedAt: null, createdAt: NOW.getTime(),
    }).run()
    return captureId
  }

  const itemRow = (d: ReturnType<typeof deps>) => d.db.select().from(topicItems).where(eq(topicItems.id, 'i1')).get()!

  it('links the item to the card it became', async () => {
    const d = deps()
    const id = accepted(d)
    await generateNewCard(d, id, NOW)
    expect(itemRow(d).cardId).toBe(d.db.select().from(cards).get()!.id)
  })

  it('links the item to the needs_input card when generation gives up', () => {
    const d = deps()
    const id = accepted(d)
    giveUpNewCard(d.db, id, 'unusable', NOW)
    const card = d.db.select().from(cards).get()!
    expect(card.status).toBe('needs_input')
    expect(itemRow(d).cardId).toBe(card.id)
  })

  // The process died after the capture learned its card but before the item
  // did; the job runs again and must finish the link.
  it('links the item when a rerun finds the card already made', async () => {
    const d = deps()
    const id = accepted(d)
    const cardId = createCard(d.db, input(), NOW).cardId
    d.db.update(captures).set({ cardId }).where(eq(captures.id, id)).run()
    await generateNewCard(d, id, NOW)
    expect(itemRow(d).cardId).toBe(cardId)
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
  })

  it('sends a hand-added item, which has no gloss, with the situation alone', async () => {
    const d = deps()
    const id = accepted(d, { glossRu: null })
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('złośliwy', { glossRu: null, context: 'u lekarza z dzieckiem' })
  })

  it('calls an item of the default topic with no gloss with the transcript alone', async () => {
    const d = deps()
    const id = accepted(d, { topicId: DEFAULT_TOPIC_ID, glossRu: null })
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('złośliwy')
  })

  it('sends the gloss and the situation, and files the card under the topic', async () => {
    const d = deps()
    const id = accepted(d)
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('złośliwy', { glossRu: 'злобный', context: 'u lekarza z dzieckiem' })
    expect(d.db.select().from(cards).get()!.topicId).toBe('t1')
    expect(row(d, id).status).toBe('generated')
  })

  it('keeps the word under the topic when generation gives up', () => {
    const d = deps()
    const id = accepted(d)
    giveUpNewCard(d.db, id, 'unusable', NOW)
    expect(d.db.select().from(cards).get()).toMatchObject({ status: 'needs_input', topicId: 't1' })
  })

  it('leaves an existing card’s topic alone when the item is a duplicate', async () => {
    const d = deps()
    const existing = createCard(d.db, input(), NOW).cardId
    const id = accepted(d)
    await generateNewCard(d, id, NOW)
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(cards).get()!).toMatchObject({ id: existing, topicId: DEFAULT_TOPIC_ID })
    // …and the item links to that card (§4.1).
    expect(itemRow(d).cardId).toBe(existing)
  })

  it('calls a plain dictation with the transcript alone, as before', async () => {
    const d = deps()
    const id = await recognized(d, 'zloslivy')
    await generateNewCard(d, id, NOW)
    expect(d.generator.fromDictation).toHaveBeenCalledWith('zloslivy')
  })
})
