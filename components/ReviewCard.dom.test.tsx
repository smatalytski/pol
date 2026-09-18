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
  answerPl: 'złośliwy',
  examplePl: 'Zrobił to ze złośliwości.',
  grammarNote: null,
  wordKind: 'przymiotnik',
  forms: { basic: [{ label: 'przysłówek', value: 'złośliwie' }], extended: [{ label: 'x', value: 'rozszerzone' }] },
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

  it('shows the basic forms with the answer, and the extended ones only on request', async () => {
    render(<ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByText('złośliwie')).toBeTruthy()
    expect(screen.queryByText('rozszerzone')).toBeNull()
    await userEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('rozszerzone')).toBeTruthy()
  })

  it('does not show forms before the answer is revealed', () => {
    render(<ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.queryByText('złośliwie')).toBeNull()
  })

  // Spec §7.2: the toggle is per card. Without a reset, opening it once would
  // leave every following card's extended forms open.
  it('closes the extended forms again for the next card', async () => {
    const { rerender } = render(
      <ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    await userEvent.click(screen.getByText(t.showAllForms))
    rerender(
      <ReviewCard card={{ ...card, id: 'b' }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByText('rozszerzone')).toBeNull()
  })

  it('shows no forms section for a phrase', () => {
    render(
      <ReviewCard card={{ ...card, wordKind: 'fraza', forms: null }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByText(t.showAllForms)).toBeNull()
  })

  // Spec §2: pl_to_pl is the Polish word as the question and its forms as the
  // answer. No Russian anywhere — not the prompt, not the hint.
  it('asks a pl_to_pl card with the Polish word and no Russian', () => {
    render(
      <ReviewCard card={{ ...card, type: 'pl_to_pl' }} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.getByText('złośliwy')).toBeTruthy()
    expect(screen.queryByText('злобный')).toBeNull()
    expect(screen.queryByText('прилагательное')).toBeNull()
  })

  it('answers a pl_to_pl card with its forms, not a second copy of the word or an example', () => {
    render(
      <ReviewCard card={{ ...card, type: 'pl_to_pl' }} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.getAllByText('złośliwy')).toHaveLength(1)
    expect(screen.getByText('złośliwie')).toBeTruthy()
    expect(screen.queryByText('Zrobił to ze złośliwości.')).toBeNull()
  })
})
