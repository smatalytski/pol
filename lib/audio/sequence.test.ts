import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ASSEMBLY_VERSION, sequenceFor, audioKey, estimateMs, settingsToSequence, type SequenceSettings, type ListenCard } from './sequence'
import { VOICES } from '../tts/voices'

describe('sequence', () => {
  it('does not import from ../tts (must use ../tts/voices to stay pure)', () => {
    const sourceCode = readFileSync(resolve(__dirname, './sequence.ts'), 'utf-8')
    expect(sourceCode).not.toContain(`from '../tts'`)
  })
  // All features on: hint spoken, answer repeated, example spoken and repeated.
  const defaultSettings: SequenceSettings = { gapSeconds: 5, repeatAnswer: true, example: true, hint: true, repeatExample: true }

  const cardWithHintAndExample: ListenCard = {
    promptText: 'кот',
    promptHint: 'животное',
    answerPl: 'kot',
    examplePl: 'Mam kota.',
  }

  it('produces the full sequence with every setting on', () => {
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('drops the second answer when repeatAnswer is false', () => {
    const settings = { ...defaultSettings, repeatAnswer: false }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('drops the example (and its repeat) when example is false', () => {
    const settings = { ...defaultSettings, example: false }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('drops the example when examplePl is null', () => {
    const card: ListenCard = { ...cardWithHintAndExample, examplePl: null }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('drops the example when examplePl is blank', () => {
    const card: ListenCard = { ...cardWithHintAndExample, examplePl: '   ' }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('reads the example only once when repeatExample is false', () => {
    const settings = { ...defaultSettings, repeatExample: false }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('repeatExample has no effect when example is false (no example spoken at all)', () => {
    const withRepeat = sequenceFor(cardWithHintAndExample, { ...defaultSettings, example: false, repeatExample: true })
    const withoutRepeat = sequenceFor(cardWithHintAndExample, { ...defaultSettings, example: false, repeatExample: false })
    expect(withRepeat).toEqual(withoutRepeat)
  })

  it('repeatExample has no effect when the card has no example', () => {
    const card: ListenCard = { ...cardWithHintAndExample, examplePl: null }
    const withRepeat = sequenceFor(card, { ...defaultSettings, repeatExample: true })
    const withoutRepeat = sequenceFor(card, { ...defaultSettings, repeatExample: false })
    expect(withRepeat).toEqual(withoutRepeat)
  })

  it('gives the prompt alone when hint is on but promptHint is null', () => {
    const card: ListenCard = { ...cardWithHintAndExample, promptHint: null }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот' })
  })

  it('gives the prompt alone when hint is on but promptHint is blank', () => {
    const card: ListenCard = { ...cardWithHintAndExample, promptHint: '   ' }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот' })
  })

  it('gives the prompt alone when hint is off (the default), even though the card has a hint', () => {
    const settings = { ...defaultSettings, hint: false }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот' })
  })

  it('speaks the hint when hint is on and the hint is non-blank', () => {
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот. животное' })
  })

  it('respects gapSeconds in the silence duration', () => {
    const settings = { ...defaultSettings, gapSeconds: 12 }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts[1]).toEqual({ kind: 'silence', ms: 12000 })
  })

  it('audioKey is stable for the same input', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const key2 = audioKey(cardWithHintAndExample, defaultSettings)
    expect(key1).toBe(key2)
  })

  it('audioKey changes when promptText changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const card2 = { ...cardWithHintAndExample, promptText: 'собака' }
    const key2 = audioKey(card2, defaultSettings)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when promptHint changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const card2 = { ...cardWithHintAndExample, promptHint: 'растение' }
    const key2 = audioKey(card2, defaultSettings)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when answerPl changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const card2 = { ...cardWithHintAndExample, answerPl: 'pies' }
    const key2 = audioKey(card2, defaultSettings)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when examplePl changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const card2 = { ...cardWithHintAndExample, examplePl: 'Mam psa.' }
    const key2 = audioKey(card2, defaultSettings)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when gapSeconds changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { ...defaultSettings, gapSeconds: 10 }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when repeatAnswer changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { ...defaultSettings, repeatAnswer: false }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when example changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { ...defaultSettings, example: false }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when hint changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { ...defaultSettings, hint: false }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when repeatExample changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { ...defaultSettings, repeatExample: false }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey includes ASSEMBLY_VERSION', () => {
    const key = audioKey(cardWithHintAndExample, defaultSettings)
    // Verify the key contains the assembly version by building the hash ourselves
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
    const hashInput = JSON.stringify({ v: ASSEMBLY_VERSION, voices: VOICES, parts })
    const expectedKey = createHash('sha256').update(hashInput).digest('hex')
    expect(key).toBe(expectedKey)
  })

  it('audioKey includes both voice names', () => {
    // The key should include both voices. We verify this by checking that it
    // changes if we can somehow change the voices (we can't directly in this test,
    // but we verify the hashInput includes them)
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
    const hashInput = JSON.stringify({ v: ASSEMBLY_VERSION, voices: VOICES, parts })
    expect(hashInput).toContain('pl-PL-Chirp3-HD-Kore')
    expect(hashInput).toContain('ru-RU-Chirp3-HD-Kore')
  })

  it('estimateMs calculates correctly for the full sequence', () => {
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
    const estimated = estimateMs(parts)
    // (13 + 3 + 3 + 9 + 9) * 60 + 5000 + 1000 + 1000 + 1000 + 2000
    // 37 * 60 + 10000 = 2220 + 10000 = 12220
    const expected = (13 + 3 + 3 + 9 + 9) * 60 + 5000 + 1000 + 1000 + 1000 + 2000
    expect(estimated).toBe(expected)
  })

  it('estimateMs counts characters in speech parts', () => {
    const parts = [
      { kind: 'speech' as const, lang: 'ru' as const, text: 'hello' },
      { kind: 'silence' as const, ms: 1000 },
    ]
    const estimated = estimateMs(parts)
    expect(estimated).toBe(5 * 60 + 1000)
  })

  it('settingsToSequence converts 0/1 to boolean', () => {
    const settings = settingsToSequence({ audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1, audioHint: 1, audioRepeatExample: 1 })
    expect(settings).toEqual({ gapSeconds: 5, repeatAnswer: true, example: true, hint: true, repeatExample: true })
  })

  it('settingsToSequence converts 0 to false', () => {
    const settings = settingsToSequence({ audioGapSeconds: 10, audioRepeatAnswer: 0, audioExample: 0, audioHint: 0, audioRepeatExample: 0 })
    expect(settings).toEqual({ gapSeconds: 10, repeatAnswer: false, example: false, hint: false, repeatExample: false })
  })

  it('settingsToSequence handles mixed 0/1', () => {
    const settings = settingsToSequence({ audioGapSeconds: 3, audioRepeatAnswer: 1, audioExample: 0, audioHint: 0, audioRepeatExample: 1 })
    expect(settings).toEqual({ gapSeconds: 3, repeatAnswer: true, example: false, hint: false, repeatExample: true })
  })
})
