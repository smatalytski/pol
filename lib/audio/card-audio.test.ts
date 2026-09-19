import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { cardAudio, media } from '../db/schema'
import { getClip } from '../tts'
import type { Synthesizer } from '../tts'
import { FfmpegMissingError, type Encoder, type EncodePart } from './ffmpeg'
import { audioKey, sequenceFor, type ListenCard, type SequenceSettings } from './sequence'
import { buildCardAudio, cachedAudio } from './card-audio'

const NOW = new Date('2026-01-01T00:00:00Z')

const CARD: ListenCard = {
  promptText: 'привет',
  promptHint: null,
  answerPl: 'cześć',
  examplePl: null,
}

const SETTINGS: SequenceSettings = { gapSeconds: 5, repeatAnswer: false, example: false }

/** Deterministic, per-(lang,text) bytes: `[lang, ...text]` as a JSON array. */
function expectedClipBytes(lang: 'pl' | 'ru', text: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([lang, ...text]))
}

function fakeSynth(): Synthesizer & { calls: () => number } {
  const synthesize = vi.fn(async (text: string, lang: 'pl' | 'ru') => ({
    bytes: expectedClipBytes(lang, text),
    mime: 'audio/mpeg',
    voice: `${lang}-voice`,
  }))
  return { synthesize, calls: () => synthesize.mock.calls.length }
}

function fakeEncoder(): Encoder & { calls: () => number; lastParts: () => EncodePart[] } {
  let lastParts: EncodePart[] = []
  const encode = vi.fn(async (parts: EncodePart[]) => {
    lastParts = parts
    return { bytes: new Uint8Array([1, 2, 3]), durationMs: 9000 }
  })
  return { encode, calls: () => encode.mock.calls.length, lastParts: () => lastParts }
}

function bytesOf(part: EncodePart): number[] {
  if (part.kind !== 'clip') throw new Error('expected a clip part')
  return Array.from(part.bytes)
}

describe('buildCardAudio', () => {
  it('encodes one clip per speech part, in order, interleaved with silences, carrying getClip’s own bytes', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder = fakeEncoder()

    await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)

    const parts = sequenceFor(CARD, SETTINGS)
    const encoded = encoder.lastParts()
    expect(encoded).toHaveLength(parts.length)

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.kind === 'silence') {
        expect(encoded[i]).toEqual({ kind: 'silence', ms: part.ms })
      } else {
        expect(encoded[i].kind).toBe('clip')
        // What getClip actually stored for this (text, lang) — read back
        // independently rather than merely re-deriving the fake's formula.
        const mediaId = await getClip(db, synth, part.text, part.lang, NOW)
        const stored = db.select().from(media).where(eq(media.id, mediaId)).get()!
        expect(bytesOf(encoded[i])).toEqual(Array.from(stored.bytes))
      }
    }
  })

  it('writes a card_audio row and a listen media row, and returns the key and duration', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder = fakeEncoder()

    const result = await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)

    expect(result.key).toBe(audioKey(CARD, SETTINGS))
    expect(result.durationMs).toBe(9000)

    const row = db.select().from(cardAudio).where(eq(cardAudio.key, result.key)).get()
    expect(row).toBeTruthy()
    expect(row!.mediaId).toBe(result.mediaId)
    expect(row!.durationMs).toBe(9000)

    const mediaRow = db.select().from(media).where(eq(media.id, result.mediaId)).get()
    expect(mediaRow).toBeTruthy()
    expect(mediaRow!.kind).toBe('listen')
    expect(mediaRow!.mime).toBe('audio/mpeg')
    expect(Array.from(mediaRow!.bytes)).toEqual([1, 2, 3])
  })

  it('a second call with the same input calls neither the synthesizer nor the encoder', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder = fakeEncoder()

    const first = await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)
    const synthCallsAfterFirst = synth.calls()
    const encoderCallsAfterFirst = encoder.calls()
    expect(encoderCallsAfterFirst).toBe(1)

    const second = await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)

    expect(second).toEqual(first)
    expect(synth.calls()).toBe(synthCallsAfterFirst)
    expect(encoder.calls()).toBe(encoderCallsAfterFirst)
  })

  it('cachedAudio is null before the first build and the row after it', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder = fakeEncoder()

    expect(cachedAudio(db, CARD, SETTINGS)).toBeNull()

    const built = await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)

    expect(cachedAudio(db, CARD, SETTINGS)).toEqual(built)
  })

  it('a changed setting builds again under a new key', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder = fakeEncoder()

    const first = await buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)

    const changed: SequenceSettings = { ...SETTINGS, gapSeconds: 6 }
    const second = await buildCardAudio({ db, synth, encoder }, CARD, changed, NOW)

    expect(second.key).not.toBe(first.key)
    expect(encoder.calls()).toBe(2)
    expect(cachedAudio(db, CARD, changed)).toEqual(second)
  })

  it('propagates FfmpegMissingError from the encoder and caches nothing', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const encoder: Encoder = {
      encode: vi.fn(async () => {
        throw new FfmpegMissingError('ffmpeg is not installed')
      }),
    }

    await expect(buildCardAudio({ db, synth, encoder }, CARD, SETTINGS, NOW)).rejects.toBeInstanceOf(
      FfmpegMissingError,
    )

    expect(cachedAudio(db, CARD, SETTINGS)).toBeNull()
    expect(db.select().from(cardAudio).all()).toHaveLength(0)
    expect(db.select().from(media).where(eq(media.kind, 'listen')).all()).toHaveLength(0)
  })
})
