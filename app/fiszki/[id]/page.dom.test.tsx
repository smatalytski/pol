// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'c1' }),
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
}))

const CardPage = (await import('./page')).default

function cardRow(over: Partial<CardRow> = {}): CardRow {
  return {
    id: 'c1',
    type: 'ru_to_pl',
    promptText: 'злобный',
    promptHint: 'прилагательное',
    promptMediaId: null,
    answerPl: 'złośliwy',
    answerKey: 'złośliwy',
    examplePl: 'Zrobił to ze złośliwości.',
    exampleRu: 'Он сделал это из злобы.',
    grammarNote: 'przymiotnik',
    status: 'ready',
    parentCardId: null,
    suspendedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1,
    due: 1,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: null,
    ...over,
  }
}

const FORMS_MARKDOWN = '| a | b |\n|---|---|\n| 1 | 2 |'

const formsCard = () =>
  cardRow({ type: 'pl_forms', answerPl: FORMS_MARKDOWN, promptText: 'patrzeć — odmiana' })

/** GET returns the card; every other verb succeeds. Records every call. */
function stubFetch(card: () => CardRow) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: card() }),
        }) as unknown as Promise<Response>
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ card: card(), duplicateOf: null, ok: true }),
      }) as unknown as Promise<Response>
    }),
  )
  return calls
}

/** GET succeeds with `card`; every write fails with `status`. */
function stubFailingWrites(card: () => CardRow, status = 502) {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: card() }),
        }) as unknown as Promise<Response>
      }
      return Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve({ error: 'boom' }),
      }) as unknown as Promise<Response>
    }),
  )
}

afterEach(() => {
  cleanup()
  pushMock.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CardDetailPage', () => {
  it('shows the card details, with the Russian prompt kept as the question', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    expect(await screen.findByDisplayValue('złośliwy')).toBeTruthy()
    expect(screen.getByDisplayValue('злобный')).toBeTruthy()
    expect(screen.getByText('прилагательное')).toBeTruthy()
    expect(screen.getByText('Zrobił to ze złośliwości.')).toBeTruthy()
    expect(screen.getByText('przymiotnik')).toBeTruthy()
  })

  // This is what the user was reaching for when they reported that nothing
  // happened on pressing play "on a selected card": the browse screen had no
  // player at all, only the review screen did.
  it('offers an answer audio player pointing at the card audio route', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    const player = await screen.findByLabelText(t.play)
    expect(player.getAttribute('src')).toBe('/api/cards/c1/audio?part=answer')
  })

  it('does not offer a player for a pl_forms card, whose answer audio 404s', async () => {
    stubFetch(formsCard)
    render(<CardPage />)
    await screen.findByRole('table')
    expect(screen.queryByLabelText(t.play)).toBeNull()
  })

  it('PATCHes the edited answer on blur, but only when it actually changed', async () => {
    const calls = stubFetch(() => cardRow())
    render(<CardPage />)
    const answer = await screen.findByDisplayValue('złośliwy')
    await act(async () => {
      fireEvent.blur(answer)
    })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    fireEvent.change(answer, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.blur(answer)
    })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ answerPl: 'wredny' })
  })

  it('lets promptText be edited, promoting a needs_input card once filled in', async () => {
    const calls = stubFetch(() => cardRow({ status: 'needs_input', promptText: null }))
    render(<CardPage />)
    const prompt = await screen.findByPlaceholderText(t.needsInput)
    fireEvent.change(prompt, { target: { value: 'злобный' } })
    await act(async () => {
      fireEvent.blur(prompt)
    })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ promptText: 'злобный' })
  })

  // Critical finding from the original review, which applies verbatim now
  // that editing has moved to this screen: an <input>'s value-sanitization
  // strips CR/LF, so a forms table's newlines never survive a round trip
  // through an editable input — the next blur would PATCH the flattened
  // string over the only copy of the table. Render it read-only instead.
  it('renders a pl_forms answer read-only through FormsTable, never as an editable <input>', async () => {
    stubFetch(formsCard)
    render(<CardPage />)
    expect(await screen.findByRole('table')).toBeTruthy()
    // The only text input is the unrelated promptText field.
    expect(screen.queryAllByRole('textbox')).toHaveLength(1)
  })

  it('never PATCHes a pl_forms card on blur, since there is no editable answer field', async () => {
    const calls = stubFetch(formsCard)
    render(<CardPage />)
    await screen.findByRole('table')
    await act(async () => {
      fireEvent.blur(screen.getByRole('textbox'))
    })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('does not offer "dodaj formy" for a pl_forms card', async () => {
    stubFetch(formsCard)
    render(<CardPage />)
    await screen.findByRole('table')
    expect(screen.queryByText(t.addForms)).toBeNull()
  })

  // On the old list screen a successful "dodaj formy" reloaded the list and
  // the new card appeared in it. Here nothing on screen changes, so without a
  // confirmation the button looks dead on success as well as on failure.
  it('POSTs to the formy route and confirms it, so a success is not silent', async () => {
    const calls = stubFetch(() => cardRow())
    render(<CardPage />)
    const button = await screen.findByText(t.addForms)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.some((c) => c.url === '/api/cards/c1/formy' && c.method === 'POST')).toBe(true)
    expect(await screen.findByText(t.formsAdded)).toBeTruthy()
  })

  it('shows an error when generating forms fails, instead of silently doing nothing', async () => {
    stubFailingWrites(() => cardRow())
    render(<CardPage />)
    const button = await screen.findByText(t.addForms)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.formsFailed)).toBeTruthy()
  })

  it('offers "wygeneruj ponownie" only for a needs_input card', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    await screen.findByDisplayValue('złośliwy')
    expect(screen.queryByText(t.regenerate)).toBeNull()
    cleanup()
    vi.unstubAllGlobals()
    stubFetch(() => cardRow({ status: 'needs_input', promptText: null }))
    render(<CardPage />)
    expect(await screen.findByText(t.regenerate)).toBeTruthy()
  })

  it('POSTs to the regeneruj route when "wygeneruj ponownie" is clicked', async () => {
    const calls = stubFetch(() => cardRow({ status: 'needs_input', promptText: null }))
    render(<CardPage />)
    const button = await screen.findByText(t.regenerate)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.some((c) => c.url === '/api/cards/c1/regeneruj' && c.method === 'POST')).toBe(true)
  })

  it('shows an error when regeneration fails, instead of looking like a dead button', async () => {
    stubFailingWrites(() => cardRow({ status: 'needs_input', promptText: null }))
    render(<CardPage />)
    const button = await screen.findByText(t.regenerate)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.regenerateFailed)).toBeTruthy()
  })

  it('tells you when the regenerated word already exists in the deck', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ card: cardRow({ status: 'needs_input', promptText: null }) }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: cardRow(), duplicateOf: 'other-card' }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.regenerate)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.regenerateDuplicate)).toBeTruthy()
  })

  it('sends a numeric suspendedAt when suspending a live card', async () => {
    const calls = stubFetch(() => cardRow({ suspendedAt: null }))
    render(<CardPage />)
    const button = await screen.findByText(t.suspend)
    await act(async () => {
      fireEvent.click(button)
    })
    const body = calls.find((c) => c.method === 'PATCH')?.body as { suspendedAt: number }
    expect(typeof body.suspendedAt).toBe('number')
  })

  it('sends suspendedAt: null when unsuspending an already-suspended card', async () => {
    const calls = stubFetch(() => cardRow({ suspendedAt: 123 }))
    render(<CardPage />)
    const button = await screen.findByText(t.unsuspend)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ suspendedAt: null })
  })

  // Deleting the card you are looking at would otherwise leave this screen
  // showing a card that no longer exists.
  it('DELETEs the card and returns to the list', async () => {
    const calls = stubFetch(() => cardRow())
    render(<CardPage />)
    const button = await screen.findByText(t.deleteItem)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.some((c) => c.url === '/api/cards/c1' && c.method === 'DELETE')).toBe(true)
    expect(pushMock).toHaveBeenCalledWith('/fiszki')
  })

  it('shows an error when a PATCH is rejected, instead of silently looking saved', async () => {
    stubFailingWrites(() => cardRow(), 400)
    render(<CardPage />)
    const answer = await screen.findByDisplayValue('złośliwy')
    fireEvent.change(answer, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.blur(answer)
    })
    expect(await screen.findByText(t.saveFailed)).toBeTruthy()
  })

  it('says so when the card does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: 'not found' }),
          }) as unknown as Promise<Response>,
      ),
    )
    render(<CardPage />)
    expect(await screen.findByText(t.cardNotFound)).toBeTruthy()
  })
})
