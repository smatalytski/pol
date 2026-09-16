// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureChip, type ChipItem } from './CaptureChip'
import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

function captureItem(over: Partial<CaptureView> = {}): ChipItem {
  return {
    kind: 'capture',
    capture: {
      id: 'cap-1',
      status: 'generated',
      transcript: 'злобный',
      error: null,
      cardId: null,
      duplicateOf: null,
      audioMediaId: null,
      createdAt: 1,
      ...over,
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
    render(<CaptureChip item={{ kind: 'outbox', id: 'o1', createdAt: 1 }} onRetry={vi.fn()} onDelete={onDelete} />)
    const li = screen.getByRole('listitem')
    swipe(li, -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('swiping left past the threshold calls onDelete with the item, whether or not it has a card', () => {
    const onDelete = vi.fn()
    const item = captureItem({ cardId: null })
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} />)
    swipe(screen.getByRole('listitem'), -100)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it('a short swipe under the threshold does not delete', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} />)
    swipe(screen.getByRole('listitem'), -20)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('tapping a capture with no card yet does nothing — there is nothing to edit', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CaptureChip item={captureItem({ cardId: null })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    swipe(screen.getByRole('listitem'), 0) // pointerdown+pointerup at the same point = a tap
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()
  })

  it('tapping a capture with a card fetches its fields and expands an edit form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              card: {
                promptText: 'злобный',
                promptHint: 'прилагательное',
                answerPl: 'złośliwy',
                examplePl: null,
                exampleRu: null,
                grammarNote: null,
              },
            }),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    await act(async () => {
      swipe(screen.getByRole('listitem'), 0)
    })
    expect(await screen.findByDisplayValue('złośliwy')).toBeTruthy()
    expect(screen.getByRole('button', { name: t.save })).toBeTruthy()
  })

  it('tapping again collapses the edit form without saving', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              card: { promptText: null, promptHint: null, answerPl: 'złośliwy', examplePl: null, exampleRu: null, grammarNote: null },
            }),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    const li = screen.getByRole('listitem')
    await act(async () => {
      swipe(li, 0)
    })
    expect(await screen.findByDisplayValue('złośliwy')).toBeTruthy()
    await act(async () => {
      swipe(li, 0)
    })
    expect(screen.queryByDisplayValue('złośliwy')).toBeNull()
  })

  // Real bug this guards against: a native tap to focus an input inside the
  // expanded form is itself a pointerdown+pointerup pair, which bubbles up to
  // the `<li>`'s own swipe/tap handler. Without stopping that propagation,
  // tapping into the answer field to edit it would read as "tap while
  // expanded" and immediately collapse the form out from under the user.
  it('tapping into an input inside the expanded form does not collapse it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              card: { promptText: null, promptHint: null, answerPl: 'złośliwy', examplePl: null, exampleRu: null, grammarNote: null },
            }),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    swipe(screen.getByRole('listitem'), 0)
    const answerInput = await screen.findByDisplayValue('złośliwy')
    swipe(answerInput, 0) // the tap-to-focus gesture a real edit starts with
    expect(screen.queryByDisplayValue('złośliwy')).toBeTruthy()
  })

  it('saving PATCHes the card with the edited fields and collapses', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (!init?.method) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                card: { promptText: 'злобный', promptHint: null, answerPl: 'złośliwy', examplePl: null, exampleRu: null, grammarNote: null },
              }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as unknown as Promise<Response>
      }),
    )
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    await act(async () => {
      swipe(screen.getByRole('listitem'), 0)
    })
    const answerInput = await screen.findByDisplayValue('złośliwy')
    fireEvent.change(answerInput, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.save }))
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall?.url).toBe('/api/cards/card-1')
    expect(patchCall?.body).toMatchObject({ answerPl: 'wredny' })
    expect(screen.queryByDisplayValue('wredny')).toBeNull() // collapsed after save
  })

  it('does not throw if the card is gone by the time the chip is tapped (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 }) as unknown as Promise<Response>))
    render(<CaptureChip item={captureItem({ cardId: 'gone' })} onRetry={vi.fn()} onDelete={vi.fn()} />)
    await act(async () => {
      swipe(screen.getByRole('listitem'), 0)
    })
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()
  })
})
