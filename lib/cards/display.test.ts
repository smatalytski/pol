import { describe, expect, it } from 'vitest'
import { cardTitle, hasAnswerAudio } from './display'

describe('cardTitle', () => {
  it('uses the Polish answer for a word card', () => {
    expect(cardTitle({ type: 'ru_to_pl', promptText: 'стирать', answerPl: 'prać' })).toBe('prać')
  })

  it('uses the Polish answer for a picture card', () => {
    expect(cardTitle({ type: 'image_to_pl', promptText: null, answerPl: 'kot' })).toBe('kot')
  })

  // A pl_forms answer is a Markdown declension table, which is unreadable as a
  // one-line title — but its prompt is already a Polish label
  // ("patrzeć — odmiana czasownika"), so that is the title.
  it('uses the Polish prompt for a forms card, never its table answer', () => {
    const title = cardTitle({
      type: 'pl_forms',
      promptText: 'patrzeć — odmiana czasownika',
      answerPl: '| Osoba | Liczba |\n| --- | --- |\n| ja | patrzę |',
    })
    expect(title).toBe('patrzeć — odmiana czasownika')
  })

  it('falls back to the answer when a forms card somehow has no prompt', () => {
    expect(cardTitle({ type: 'pl_forms', promptText: null, answerPl: 'x' })).toBe('x')
  })
})

// Moved here verbatim from components/ReviewCard.tsx, which had it as a
// private helper — the card detail screen needs the same rule, and two copies
// of "which card types can be spoken" would drift from the audio route's
// eligibility table independently.
describe('hasAnswerAudio', () => {
  it('allows the answer to be spoken for word and picture cards', () => {
    expect(hasAnswerAudio('ru_to_pl')).toBe(true)
    expect(hasAnswerAudio('image_to_pl')).toBe(true)
  })

  it('refuses a forms card, whose answer is a table the audio route 404s on', () => {
    expect(hasAnswerAudio('pl_forms')).toBe(false)
  })
})
