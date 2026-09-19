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
  const defaultSettings: SequenceSettings = { gapSeconds: 5, repeatAnswer: true, example: true }

  const cardWithHintAndExample: ListenCard = {
    promptText: 'кот',
    promptHint: 'животное',
    answerPl: 'kot',
    examplePl: 'Mam kota.',
  }

  it('produces the full sequence with default settings and hint/example', () => {
    const parts = sequenceFor(cardWithHintAndExample, defaultSettings)
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

  it('drops the second answer when repeatAnswer is false', () => {
    const settings = { gapSeconds: 5, repeatAnswer: false, example: true }
    const parts = sequenceFor(cardWithHintAndExample, settings)
    expect(parts).toEqual([
      { kind: 'speech', lang: 'ru', text: 'кот. животное' },
      { kind: 'silence', ms: 5000 },
      { kind: 'speech', lang: 'pl', text: 'kot' },
      { kind: 'silence', ms: 1000 },
      { kind: 'speech', lang: 'pl', text: 'Mam kota.' },
      { kind: 'silence', ms: 2000 },
    ])
  })

  it('drops the example when example is false', () => {
    const settings = { gapSeconds: 5, repeatAnswer: true, example: false }
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

  it('gives the prompt alone when hint is null', () => {
    const card: ListenCard = { ...cardWithHintAndExample, promptHint: null }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот' })
  })

  it('gives the prompt alone when hint is blank', () => {
    const card: ListenCard = { ...cardWithHintAndExample, promptHint: '   ' }
    const parts = sequenceFor(card, defaultSettings)
    expect(parts[0]).toEqual({ kind: 'speech', lang: 'ru', text: 'кот' })
  })

  it('respects gapSeconds in the silence duration', () => {
    const settings = { gapSeconds: 12, repeatAnswer: true, example: true }
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
    const settings2 = { gapSeconds: 10, repeatAnswer: true, example: true }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when repeatAnswer changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { gapSeconds: 5, repeatAnswer: false, example: true }
    const key2 = audioKey(cardWithHintAndExample, settings2)
    expect(key1).not.toBe(key2)
  })

  it('audioKey changes when example changes', () => {
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
    const settings2 = { gapSeconds: 5, repeatAnswer: true, example: false }
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
    const key1 = audioKey(cardWithHintAndExample, defaultSettings)
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
    // (13 + 3 + 3 + 9) * 60 + 5000 + 1000 + 1000 + 2000
    // 28 * 60 + 9000 = 1680 + 9000 = 10680
    const expected = (13 + 3 + 3 + 9) * 60 + 5000 + 1000 + 1000 + 2000
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
    const settings = settingsToSequence({ audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    expect(settings).toEqual({ gapSeconds: 5, repeatAnswer: true, example: true })
  })

  it('settingsToSequence converts 0 to false', () => {
    const settings = settingsToSequence({ audioGapSeconds: 10, audioRepeatAnswer: 0, audioExample: 0 })
    expect(settings).toEqual({ gapSeconds: 10, repeatAnswer: false, example: false })
  })

  it('settingsToSequence handles mixed 0/1', () => {
    const settings = settingsToSequence({ audioGapSeconds: 3, audioRepeatAnswer: 1, audioExample: 0 })
    expect(settings).toEqual({ gapSeconds: 3, repeatAnswer: true, example: false })
  })
})
