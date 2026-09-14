import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { media, ttsClips } from '../db/schema'
import { clipId, getClip, ttsSynthesizer, VOICES, type Synthesizer } from './index'

function fakeSynth(): Synthesizer & { calls: () => number } {
  const synthesize = vi.fn(async (_t: string, lang: 'pl' | 'ru') => ({
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'audio/mpeg',
    voice: VOICES[lang],
  }))
  return { synthesize, calls: () => synthesize.mock.calls.length }
}

const NOW = new Date('2026-01-01T00:00:00Z')

describe('getClip', () => {
  it('synthesizes once and reuses the clip forever', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const a = await getClip(db, synth, 'złośliwy', 'pl', NOW)
    const b = await getClip(db, synth, 'złośliwy', 'pl', NOW)
    expect(a).toBe(b)
    expect(synth.calls()).toBe(1)
    expect(db.select().from(media).all()).toHaveLength(1)
    expect(db.select().from(ttsClips).all()).toHaveLength(1)
  })

  it('treats the same text in different languages as different clips', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    expect(await getClip(db, synth, 'ton', 'pl', NOW)).not.toBe(
      await getClip(db, synth, 'ton', 'ru', NOW),
    )
    expect(synth.calls()).toBe(2)
  })

  it('edited text yields a new clip and leaves the old one alone', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const oldId = await getClip(db, synth, 'złosliwy', 'pl', NOW)
    const oldRow = db.select().from(ttsClips).where(eqId(oldId)).all()
    await getClip(db, synth, 'złośliwy', 'pl', NOW)
    expect(db.select().from(ttsClips).all()).toHaveLength(2)
    // The old row's content is untouched, not merely that a second row exists.
    expect(db.select().from(ttsClips).where(eqId(oldId)).all()).toEqual(oldRow)
  })

  it('derives the id from text, language and voice', () => {
    expect(clipId('x', 'pl', 'v1')).toBe(clipId('x', 'pl', 'v1'))
    expect(clipId('x', 'pl', 'v1')).not.toBe(clipId('x', 'pl', 'v2'))
    expect(clipId('x', 'pl', 'v1')).not.toBe(clipId('x', 'ru', 'v1'))
    expect(clipId('x', 'pl', 'v1')).not.toBe(clipId('y', 'pl', 'v1'))
  })

  it('deduplicates two concurrent requests for the same clip into one synthesis call', async () => {
    const { db } = createTestDb()
    const synth = fakeSynth()
    const [a, b] = await Promise.all([
      getClip(db, synth, 'złośliwy', 'pl', NOW),
      getClip(db, synth, 'złośliwy', 'pl', NOW),
    ])
    expect(a).toBe(b)
    expect(synth.calls()).toBe(1)
    expect(db.select().from(ttsClips).all()).toHaveLength(1)
  })
})

function eqId(mediaId: string) {
  return eq(ttsClips.mediaId, mediaId)
}

describe('ttsSynthesizer', () => {
  const okClient = (audioContent: Uint8Array | string) =>
    vi.fn().mockResolvedValue([{ audioContent }])

  it('requests the pinned voice and returns the audio bytes', async () => {
    const synthesizeSpeech = okClient(new Uint8Array([7, 8]))
    const out = await ttsSynthesizer({ synthesizeSpeech: synthesizeSpeech as never }).synthesize(
      'złośliwy',
      'pl',
    )
    expect([...out.bytes]).toEqual([7, 8])
    expect(out.voice).toBe(VOICES.pl)
    const req = synthesizeSpeech.mock.calls[0][0] as {
      input: { text: string }
      voice: { languageCode: string; name: string }
    }
    expect(req.voice).toEqual({ languageCode: 'pl-PL', name: VOICES.pl })
    expect(req.input).toEqual({ text: 'złośliwy' })
  })

  it('accepts a base64 string as well as bytes, since the client may return either', async () => {
    const synthesizeSpeech = okClient(Buffer.from([9, 10]).toString('base64'))
    const out = await ttsSynthesizer({ synthesizeSpeech: synthesizeSpeech as never }).synthesize(
      'x',
      'ru',
    )
    expect([...out.bytes]).toEqual([9, 10])
    expect(out.voice).toBe(VOICES.ru)
  })

  it('pins a Chirp 3 HD voice for both languages', () => {
    expect(VOICES.pl).toMatch(/^pl-PL-Chirp3-HD-/)
    expect(VOICES.ru).toMatch(/^ru-RU-Chirp3-HD-/)
  })

  it('throws on an API failure', async () => {
    const synthesizeSpeech = vi.fn().mockRejectedValue(new Error('permission denied'))
    await expect(
      ttsSynthesizer({ synthesizeSpeech: synthesizeSpeech as never }).synthesize('x', 'pl'),
    ).rejects.toThrow(/tts failed/)
  })

  it('throws when no audio comes back, so an empty clip is never cached', async () => {
    const synthesizeSpeech = vi.fn().mockResolvedValue([{ audioContent: null }])
    await expect(
      ttsSynthesizer({ synthesizeSpeech: synthesizeSpeech as never }).synthesize('x', 'pl'),
    ).rejects.toThrow(/tts failed/)
  })
})
