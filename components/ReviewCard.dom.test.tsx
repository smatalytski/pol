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

  it('renders an image prompt for a picture card', () => {
    render(
      <ReviewCard
        card={{ ...card, type: 'image_to_pl', promptText: null, promptHint: null, promptMediaId: 'm1' }}
        revealed={false}
        canUndo={false}
        onReveal={vi.fn()}
        onRate={vi.fn()}
        onUndo={vi.fn()}
      />,
    )
    expect(screen.getByRole('img').getAttribute('src')).toBe('/api/media/m1')
  })

  it('offers undo only when there is something to undo', () => {
    const { rerender } = render(
      <ReviewCard card={card} revealed={false} canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: t.undo })).toBeNull()
    rerender(<ReviewCard card={card} revealed={false} canUndo onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />)
    expect(screen.getByRole('button', { name: t.undo })).toBeTruthy()
  })

  // Task 11 fixed GET /api/cards/:id/audio to 404 on `part=answer` for
  // pl_forms cards (its answer is a declension table, never spoken). A play
  // control that always renders would point at that 404 on every forms card,
  // so eligibility here must mirror the route's table exactly.
  it('does not offer a play control for a pl_forms card, whose answer audio 404s', () => {
    render(
      <ReviewCard
        card={{ ...card, type: 'pl_forms', promptText: 'dopełniacz l.mn.' }}
        revealed
        canUndo={false}
        onReveal={vi.fn()}
        onRate={vi.fn()}
        onUndo={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText(t.play)).toBeNull()
  })

  // Decided 2026-09-16: pl_forms answers are Markdown (bold + pipe tables)
  // and must render as real elements, not literal `**pies**` syntax.
  it('renders a pl_forms answer through FormsTable instead of as literal Markdown', () => {
    render(
      <ReviewCard
        card={{ ...card, type: 'pl_forms', promptText: 'dopełniacz l.mn.', answerPl: '**pies** → o **psie**' }}
        revealed
        canUndo={false}
        onReveal={vi.fn()}
        onRate={vi.fn()}
        onUndo={vi.fn()}
      />,
    )
    expect(screen.queryByText('**pies** → o **psie**')).toBeNull()
    expect(screen.getByText('pies').tagName).toBe('STRONG')
  })

  it('offers a play control for the answer of ru_to_pl and image_to_pl cards', () => {
    const { rerender } = render(
      <ReviewCard card={card} revealed canUndo={false} onReveal={vi.fn()} onRate={vi.fn()} onUndo={vi.fn()} />,
    )
    expect(screen.getByLabelText(t.play)).toBeTruthy()
    rerender(
      <ReviewCard
        card={{ ...card, type: 'image_to_pl', promptText: null, promptMediaId: 'm1' }}
        revealed
        canUndo={false}
        onReveal={vi.fn()}
        onRate={vi.fn()}
        onUndo={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(t.play)).toBeTruthy()
  })
})
