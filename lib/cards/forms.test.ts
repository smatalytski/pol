import { describe, expect, it } from 'vitest'
import { hasForms, parseForms, serializeForms, type CardForms } from './forms'

const NOUN: CardForms = {
  basic: [{ label: 'M. l.mn.', value: 'koty' }],
  extended: [{ label: 'C.', value: 'kotu · kotom' }],
}

describe('hasForms', () => {
  it('is true for the four kinds that inflect or derive', () => {
    for (const k of ['rzeczownik', 'czasownik', 'przymiotnik', 'przyslowek'] as const) expect(hasForms(k)).toBe(true)
  })

  it('is false for a phrase, another part of speech, and an unclassified card', () => {
    expect(hasForms('fraza')).toBe(false)
    expect(hasForms('inne')).toBe(false)
    expect(hasForms(null)).toBe(false)
  })
})

describe('serializeForms / parseForms', () => {
  it('round-trips', () => {
    expect(parseForms(serializeForms(NOUN))).toEqual(NOUN)
  })

  it('stores nothing when both lists are empty', () => {
    expect(serializeForms({ basic: [], extended: [] })).toBeNull()
  })

  it('reads null as no forms', () => {
    expect(parseForms(null)).toBeNull()
  })

  // forms_json is only ever written by this app, but a review screen must not
  // crash on a corrupt value — it shows no forms instead.
  it('reads corrupt JSON as no forms rather than throwing', () => {
    expect(parseForms('{not json')).toBeNull()
  })

  it('drops rows that are not {label, value} strings', () => {
    expect(parseForms('{"basic":[{"label":"a","value":"b"},{"label":1},"x"],"extended":[]}')).toEqual({
      basic: [{ label: 'a', value: 'b' }],
      extended: [],
    })
  })
})
