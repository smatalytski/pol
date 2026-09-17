import { describe, expect, it } from 'vitest'
import { answerKey } from './answer-key'

describe('answerKey', () => {
  it('lowercases and trims', () => {
    expect(answerKey('  Złośliwy  ')).toBe('złośliwy')
  })

  it('collapses internal whitespace', () => {
    expect(answerKey('na   wszelki\twypadek')).toBe('na wszelki wypadek')
  })

  it('strips punctuation', () => {
    expect(answerKey('Nie ma co liczyć na jego pomoc!')).toBe('nie ma co liczyć na jego pomoc')
        expect(answerKey('„przebiegły”')).toBe('przebiegły')
  })

  it('PRESERVES diacritics — łaska and laska are different words', () => {
    expect(answerKey('łaska')).not.toBe(answerKey('laska'))
    expect(answerKey('Łaska')).toBe('łaska')
  })

  it('normalizes unicode composition so a combining accent matches a precomposed one', () => {
    expect(answerKey('skłoń')).toBe(answerKey('skłoń'.normalize('NFD')))
  })

  it('is idempotent', () => {
    const once = answerKey('Zrobił to ze złośliwości!')
    expect(answerKey(once)).toBe(once)
  })
})
