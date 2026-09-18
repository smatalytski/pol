import { describe, expect, it } from 'vitest'
import type { QueueItem } from '@/lib/review/queue'
import { currentCard, initialReviewState, reviewReducer } from './useReviewSession'

const card = (id: string): QueueItem => ({
  id,
  type: 'ru_to_pl',
  promptText: 'злобный',
  promptHint: null,
  answerPl: 'złośliwy',
  examplePl: null,
  grammarNote: null,
  wordKind: null,
  forms: null,
  isNew: false,
})

const loaded = reviewReducer(initialReviewState, { type: 'loaded', queue: [card('a'), card('b')] })

describe('reviewReducer', () => {
  it('starts empty and hidden', () => {
    expect(currentCard(initialReviewState)).toBeNull()
    expect(initialReviewState.revealed).toBe(false)
  })

  it('shows the first card face down after loading', () => {
    expect(currentCard(loaded)?.id).toBe('a')
    expect(loaded.revealed).toBe(false)
  })

  it('reveals the answer without advancing', () => {
    const s = reviewReducer(loaded, { type: 'reveal' })
    expect(s.revealed).toBe(true)
    expect(currentCard(s)?.id).toBe('a')
  })

  it('advances on a rating and hides the next answer', () => {
    const s = reviewReducer(reviewReducer(loaded, { type: 'reveal' }), { type: 'rate' })
    expect(currentCard(s)?.id).toBe('b')
    expect(s.revealed).toBe(false)
    expect(s.lastRated?.id).toBe('a')
  })

  it('puts the card back on undo, face down', () => {
    const rated = reviewReducer(loaded, { type: 'rate' })
    const s = reviewReducer(rated, { type: 'undo' })
    expect(currentCard(s)?.id).toBe('a')
    expect(s.revealed).toBe(false)
    expect(s.lastRated).toBeNull()
  })

  it('cannot undo twice', () => {
    const once = reviewReducer(reviewReducer(loaded, { type: 'rate' }), { type: 'undo' })
    expect(reviewReducer(once, { type: 'undo' })).toEqual(once)
  })

  it('ignores rate and reveal on an empty queue', () => {
    expect(reviewReducer(initialReviewState, { type: 'rate' })).toEqual(initialReviewState)
    expect(reviewReducer(initialReviewState, { type: 'reveal' })).toEqual(initialReviewState)
  })

  it('ends the session when the last card is rated', () => {
    let s = loaded
    s = reviewReducer(s, { type: 'rate' })
    s = reviewReducer(s, { type: 'rate' })
    expect(currentCard(s)).toBeNull()
  })
})
