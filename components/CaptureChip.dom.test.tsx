// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureChip, type ChipItem } from './CaptureChip'
import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

function captureItem(over: Partial<CaptureView> = {}): ChipItem {
  return {
    kind: 'capture',
    capture: {
      id: 'cap-1', status: 'transcribed', transcript: 'kot', error: null, duplicateOf: null,
      createdAt: 1, inReview: true, reviewRemainingMs: 6_000, ...over,
    },
  }
}

function swipe(el: Element, dx: number) {
  fireEvent.pointerDown(el, { clientX: 200 })
  fireEvent.pointerUp(el, { clientX: 200 + dx })
}

describe('CaptureChip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('leaves an outbox chip exactly as before — no swipe/tap wiring', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={{ kind: 'outbox', id: 'o1', createdAt: 1 }} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    const li = screen.getByRole('listitem')
    swipe(li, -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('swiping left past the threshold calls onDelete with the item', () => {
    const onDelete = vi.fn()
    const item = captureItem()
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    swipe(screen.getByRole('listitem'), -100)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it('a short swipe under the threshold does not delete', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    swipe(screen.getByRole('listitem'), -20)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('offers no language controls on an outbox chip, which has no server row yet', () => {
    render(
      <CaptureChip
        item={{ kind: 'outbox', id: 'o1', createdAt: 1 }}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.asRussian)).toBeNull()
  })

  it('asks for Russian re-recognition of this capture', () => {
    const onRelanguage = vi.fn()
    render(
      <CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={onRelanguage} />,
    )
    fireEvent.click(screen.getByText(t.asRussian))
    expect(onRelanguage).toHaveBeenCalledWith('cap-1', 'ru')
  })

  // Every control on this chip has to stop its own pointer events: the <li>
  // reads pointerdown+pointerup as a tap or a swipe, so without this, pressing
  // the control would also delete the chip.
  it('pressing a language control does not also swipe the chip away', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    swipe(screen.getByText(t.asRussian), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  // Spec §7.1: swipe-left always deleted a chip, but nothing on screen said
  // so — the user asked for a delete that already existed, because they could
  // not see it.
  it('has a visible delete control', () => {
    const onDelete = vi.fn()
    const item = captureItem()
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    fireEvent.click(screen.getByText(t.deleteItem))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  // The delete button's own onClick already covers "clicking it deletes
  // exactly the item". This covers the button's pointer-bubbling guard: a
  // swipe gesture that starts and ends on the button dispatches only
  // pointerdown/pointerup, no click, so it must not also fall through to the
  // <li>'s own swipe handler and trigger a second, uncontrolled delete.
  it('swiping across the delete button does not also trigger the li swipe handler', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} />)
    swipe(screen.getByText(t.deleteItem), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows no audio player — the chip is status only', () => {
    const { container } = render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(container.querySelector('audio')).toBeNull()
  })

  it('offers re-recognition while under review', () => {
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(screen.getByText(t.asRussian)).toBeTruthy()
  })

  it('offers ponów, not re-recognition, when recognition failed', () => {
    render(
      <CaptureChip
        item={captureItem({ status: 'failed', transcript: null, error: 'unintelligible', inReview: false, reviewRemainingMs: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()}
      />,
    )
    expect(screen.getByText(t.retry)).toBeTruthy()
    expect(screen.queryByText(t.asRussian)).toBeNull()
    expect(screen.getByText('unintelligible')).toBeTruthy()
  })

  it('says już masz for a word already in the deck', () => {
    render(<CaptureChip item={captureItem({ duplicateOf: 'card-9' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />)
    expect(screen.getByText(t.alreadyHave)).toBeTruthy()
  })

  // The bar is cosmetic — the server decides — but it must track what the
  // server says is left, so the fade never looks like a glitch.
  it('draws the review bar from the server-computed remaining time', () => {
    const { container } = render(
      <CaptureChip item={captureItem({ reviewRemainingMs: 2_500 })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} />,
    )
    const bar = container.querySelector('[data-review-bar]') as HTMLElement
    expect(bar.style.width).toBe('25%')
  })

  it('shows rozpoznawanie… while recognition runs', () => {
    render(
      <CaptureChip
        item={captureItem({ status: 'uploaded', transcript: null, inReview: false, reviewRemainingMs: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()}
      />,
    )
    expect(screen.getByText(t.transcribing)).toBeTruthy()
  })
})
