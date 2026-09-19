import { describe, expect, it } from 'vitest'
import { mixTarget, pickBatch, requestSize, type SuggestedItem } from './rounds'

const item = (answer_pl: string, kind: 'slowo' | 'fraza' = 'slowo'): SuggestedItem => ({
  answer_pl, gloss_ru: 'перевод', kind,
})

describe('requestSize', () => {
  // Half as many again as the batch needs, so dedup can drop some and still
  // leave a full batch (spec §5).
  it('asks for count × 1.5, rounded up', () => {
    expect(requestSize(5)).toBe(8)
    expect(requestSize(10)).toBe(15)
    expect(requestSize(20)).toBe(30)
  })
})

describe('mixTarget', () => {
  it('splits a request by the mix', () => {
    expect(mixTarget(15, 'mieszane')).toEqual({ words: 8, phrases: 7 })
    expect(mixTarget(15, 'slowa')).toEqual({ words: 15, phrases: 0 })
    expect(mixTarget(15, 'frazy')).toEqual({ words: 0, phrases: 15 })
  })
})

describe('pickBatch', () => {
  it('keeps the first `count` items in order', () => {
    const got = pickBatch([item('a'), item('b'), item('c')], new Set(), 2, 'mieszane')
    expect(got.map((i) => i.answer_pl)).toEqual(['a', 'b'])
  })

  it('drops anything already taken, compared by answer key', () => {
    const got = pickBatch([item('Gorączka!'), item('katar')], new Set(['gorączka']), 10, 'mieszane')
    expect(got.map((i) => i.answer_pl)).toEqual(['katar'])
  })

  it('drops a repeat within the same response', () => {
    const got = pickBatch([item('katar'), item('Katar.'), item('kaszel')], new Set(), 10, 'mieszane')
    expect(got.map((i) => i.answer_pl)).toEqual(['katar', 'kaszel'])
  })

  // Diacritics are never folded (lib/cards/answer-key.ts): ł and l are
  // different letters, so these are two different words.
  it('does not treat a diacritic variant as a repeat', () => {
    const got = pickBatch([item('łza'), item('lza')], new Set(), 10, 'mieszane')
    expect(got).toHaveLength(2)
  })

  it('trims text and skips empty items', () => {
    const got = pickBatch([{ answer_pl: '  ', gloss_ru: 'x', kind: 'slowo' }, { answer_pl: ' katar ', gloss_ru: ' насморк ', kind: 'slowo' }], new Set(), 10, 'mieszane')
    expect(got).toEqual([{ answer_pl: 'katar', gloss_ru: 'насморк', kind: 'slowo' }])
  })

  it('returns a short batch rather than inventing items', () => {
    expect(pickBatch([item('a')], new Set(), 10, 'mieszane')).toHaveLength(1)
  })

  it('keeps only words for slowa and only phrases for frazy, after dedup', () => {
    const items = [item('katar'), item('ma gorączkę', 'fraza'), item('kaszel'), item('boli go gardło', 'fraza')]
    expect(pickBatch(items, new Set(['katar']), 10, 'slowa').map((i) => i.answer_pl)).toEqual(['kaszel'])
    expect(pickBatch(items, new Set(), 1, 'frazy').map((i) => i.answer_pl)).toEqual(['ma gorączkę'])
  })
})
