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
      cardType: null,
      wordKind: null,
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
    render(<CaptureChip item={{ kind: 'outbox', id: 'o1', createdAt: 1 }} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    const li = screen.getByRole('listitem')
    swipe(li, -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('swiping left past the threshold calls onDelete with the item, whether or not it has a card', () => {
    const onDelete = vi.fn()
    const item = captureItem({ cardId: null })
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    swipe(screen.getByRole('listitem'), -100)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it('a short swipe under the threshold does not delete', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem()} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    swipe(screen.getByRole('listitem'), -20)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('tapping a capture with no card yet does nothing — there is nothing to edit', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CaptureChip item={captureItem({ cardId: null })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
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
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
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
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
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
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
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
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
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

  // Important review finding (A3): save() never checked the response status.
  it('shows an error and keeps the form open when the PATCH is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init?.method) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                card: { promptText: null, promptHint: null, answerPl: 'złośliwy', examplePl: null, exampleRu: null, grammarNote: null },
              }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) }) as unknown as Promise<Response>
      }),
    )
    render(<CaptureChip item={captureItem({ cardId: 'card-1' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    await act(async () => {
      swipe(screen.getByRole('listitem'), 0)
    })
    const answerInput = await screen.findByDisplayValue('złośliwy')
    fireEvent.change(answerInput, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t.save }))
    })
    expect(await screen.findByText(t.chipSaveFailed)).toBeTruthy()
    // Form stays open with the edit intact, rather than silently collapsing
    // as if the save had succeeded.
    expect(screen.getByDisplayValue('wredny')).toBeTruthy()
  })

  it('does not throw if the card is gone by the time the chip is tapped (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 }) as unknown as Promise<Response>))
    render(<CaptureChip item={captureItem({ cardId: 'gone' })} onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    await act(async () => {
      swipe(screen.getByRole('listitem'), 0)
    })
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()
  })

  // Dictation is recognised as Polish, because that is what nearly all of it
  // is and because a two-language recognizer demonstrably swallows Russian
  // (spoken "склеп" came back "sklep"). A Russian recording is fixed here,
  // from the audio — the wrong transcript keeps no trace of what was said.
  it('offers both languages for a capture that has audio', () => {
    render(
      <CaptureChip
        item={captureItem({ audioMediaId: 'm1' })}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={vi.fn()}
        onSetType={vi.fn()}
      />,
    )
    expect(screen.getByText(t.asPolish)).toBeTruthy()
    expect(screen.getByText(t.asRussian)).toBeTruthy()
  })

  it('offers no language controls when there is no audio to re-recognise', () => {
    render(
      <CaptureChip
        item={captureItem({ audioMediaId: null })}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={vi.fn()}
        onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.asRussian)).toBeNull()
  })

  it('offers no language controls on an outbox chip, which has no server row yet', () => {
    render(
      <CaptureChip
        item={{ kind: 'outbox', id: 'o1', createdAt: 1 }}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={vi.fn()}
        onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.asRussian)).toBeNull()
  })

  it('asks for Russian re-recognition of this capture', () => {
    const onRelanguage = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ audioMediaId: 'm1' })}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={onRelanguage}
        onSetType={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(t.asRussian))
    expect(onRelanguage).toHaveBeenCalledWith('cap-1', 'ru')
  })

  // Every control on this chip has to stop its own pointer events: the <li>
  // reads pointerdown+pointerup as a tap or a swipe, so without this, pressing
  // the control would also delete or expand the chip.
  it('pressing a language control does not also swipe the chip away', () => {
    const onDelete = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ audioMediaId: 'm1' })}
        onRetry={vi.fn()}
        onDelete={onDelete}
        onRelanguage={vi.fn()}
        onSetType={vi.fn()}
      />,
    )
    swipe(screen.getByText(t.asRussian), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  // A capture can carry an error while still having produced a card: that is
  // exactly what a transient Vertex 429 does, and it is how the user's
  // "Zdrów jak ryba" card ended up stranded with nothing on screen saying
  // why. A failed re-recognition lands the same way — error set, status left
  // alone — so the error is shown whenever there is one, not only when the
  // capture's status is 'failed'.
  it('shows an error on a capture that still produced a card', () => {
    render(
      <CaptureChip
        item={captureItem({ status: 'generated', error: '429 RESOURCE_EXHAUSTED', audioMediaId: 'm1' })}
        onRetry={vi.fn()}
        onDelete={vi.fn()}
        onRelanguage={vi.fn()}
        onSetType={vi.fn()}
      />,
    )
    expect(screen.getByText(/RESOURCE_EXHAUSTED/)).toBeTruthy()
  })

  it('offers the type switch for a word with forms', () => {
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.getByText(t.typePlPl)).toBeTruthy()
  })

  it('offers no type switch for a phrase, or before a card exists', () => {
    const { rerender } = render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'fraza' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.typePlPl)).toBeNull()
    rerender(
      <CaptureChip
        item={captureItem({ cardId: null })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    expect(screen.queryByText(t.typePlPl)).toBeNull()
  })

  it('asks to make this capture card forms-only', () => {
    const onSetType = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={vi.fn()} onRelanguage={vi.fn()} onSetType={onSetType}
      />,
    )
    fireEvent.click(screen.getByText(t.typePlPl))
    expect(onSetType).toHaveBeenCalledWith('c1', 'pl_to_pl')
  })

  // Spec §7.1: swipe-left always deleted a chip, but nothing on screen said
  // so — the user asked for a delete that already existed, because they could
  // not see it.
  it('has a visible delete control', () => {
    const onDelete = vi.fn()
    const item = captureItem({ cardId: 'c1' })
    render(<CaptureChip item={item} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    fireEvent.click(screen.getByText(t.deleteItem))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(item)
  })

  it('pressing the type switch does not also swipe the chip away', () => {
    const onDelete = vi.fn()
    render(
      <CaptureChip
        item={captureItem({ cardId: 'c1', cardType: 'ru_to_pl', wordKind: 'rzeczownik' })}
        onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()}
      />,
    )
    swipe(screen.getByText(t.typePlPl), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })

  // The delete button's own onClick already covers "clicking it deletes
  // exactly the item". This covers the button's pointer-bubbling guard: a
  // swipe gesture that starts and ends on the button dispatches only
  // pointerdown/pointerup, no click, so it must not also fall through to the
  // <li>'s own swipe handler and trigger a second, uncontrolled delete.
  it('swiping across the delete button does not also trigger the li swipe handler', () => {
    const onDelete = vi.fn()
    render(<CaptureChip item={captureItem({ cardId: 'c1' })} onRetry={vi.fn()} onDelete={onDelete} onRelanguage={vi.fn()} onSetType={vi.fn()} />)
    swipe(screen.getByText(t.deleteItem), -100)
    expect(onDelete).not.toHaveBeenCalled()
  })
})
