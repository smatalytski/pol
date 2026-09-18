// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { QueueItem } from '@/lib/review/queue'
import { t } from '@/i18n/pl'
import { ReviewCard } from './ReviewCard'

const card: QueueItem = {
  id: 'a',
  type: 'ru_to_pl',
  promptText: 'злобный',
  promptHint: 'прилагательное',
  promptMediaId: null,
  answerPl: 'złośliwy',
  examplePl: 'Zrobił to ze złośliwości.',
  exampleRu: 'Он сделал это из злобы.',
  grammarNote: null,
  isNew: true,
}

describe('ReviewCard', () => {
  it('shows the Russian prompt and its hint, and hides the answer', () => {
    render(<ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByText('злобный')).toBeTruthy()
    expect(screen.getByText('прилагательное')).toBeTruthy()
    expect(screen.queryByText('złośliwy')).toBeNull()
    expect(screen.getByRole('button', { name: t.show })).toBeTruthy()
  })

  // The answer side is Polish only: the Russian prompt is the retrieval cue,
  // but once the card is turned over, a Russian translation of the Polish
  // example gives the eye somewhere easier to land than the Polish it is
  // meant to be reading.
  it('never shows the Russian example translation on the revealed answer side', () => {
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByText('Zrobi\u0142 to ze z\u0142o\u015bliwo\u015bci.')).toBeTruthy()
    expect(screen.queryByText('\u041e\u043d \u0441\u0434\u0435\u043b\u0430\u043b \u044d\u0442\u043e \u0438\u0437 \u0437\u043b\u043e\u0431\u044b.')).toBeNull()
  })

  it('offers no rating buttons until the answer is revealed', () => {
    render(<ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    for (const label of [t.again, t.hard, t.good, t.easy]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('shows the answer and all four ratings once revealed', () => {
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByText('złośliwy')).toBeTruthy()
    expect(screen.getByText('Zrobił to ze złośliwości.')).toBeTruthy()
    for (const label of [t.again, t.hard, t.good, t.easy]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('reports the FSRS rating value for each button', async () => {
    const onRate = vi.fn()
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={onRate} onUndo={vi.fn()} />)
    for (const [label, value] of [[t.again, 1], [t.hard, 2], [t.good, 3], [t.easy, 4]] as const) {
      await userEvent.click(screen.getByRole('button', { name: label }))
      expect(onRate).toHaveBeenLastCalledWith(value)
    }
  })

  it('offers undo only when there is something to undo', () => {
    const { rerender } = render(
      <ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: t.undo })).toBeNull()
    rerender(<ReviewCard card={card} revealed={false} canUndo onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByRole('button', { name: t.undo })).toBeTruthy()
  })

  it('offers a play control for the answer of a ru_to_pl card', () => {
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByLabelText(t.play)).toBeTruthy()
  })
})
