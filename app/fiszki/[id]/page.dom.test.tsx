// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    answerPl: 'złośliwy',
    answerKey: 'złośliwy',
    examplePl: 'Zrobił to ze złośliwości.',
    exampleRu: 'Он сделал это из злобы.',
    grammarNote: 'przymiotnik',
    wordKind: null,
    formsJson: null,
    status: 'ready',
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
    topicId: null,
    ...over,
  }
}

/** GET returns the card and whether a job is in flight; every other verb succeeds. */
function stubFetch(card: () => CardRow, generating = false) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: card(), generating }),
        }) as unknown as Promise<Response>
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ card: card(), duplicateOf: null, error: null, ok: true }),
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

const FORMS = JSON.stringify({
  basic: [{ label: 'M. l.mn.', value: 'koty' }],
  extended: [{ label: 'C.', value: 'kotu · kotom' }],
})
const noun = () => cardRow({ answerPl: 'kot', wordKind: 'rzeczownik', formsJson: FORMS })

describe('CardDetailPage', () => {
  it('shows the basic forms, with the extended ones behind a tap', async () => {
    stubFetch(noun)
    render(<CardPage />)
    expect(await screen.findByText('koty')).toBeTruthy()
    expect(screen.queryByText('kotu · kotom')).toBeNull()
    fireEvent.click(screen.getByText(t.showAllForms))
    expect(screen.getByText('kotu · kotom')).toBeTruthy()
  })

  it('offers the type switch for a word with forms, and not for a phrase', async () => {
    stubFetch(noun)
    render(<CardPage />)
    expect(await screen.findByText(t.typePlPl)).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()
    stubFetch(() => cardRow({ wordKind: 'fraza', formsJson: null }))
    render(<CardPage />)
    await screen.findByDisplayValue('złośliwy')
    expect(screen.queryByText(t.typePlPl)).toBeNull()
  })

  it('switches the card to forms-only and shows the result', async () => {
    let type: 'ru_to_pl' | 'pl_to_pl' = 'ru_to_pl'
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (method === 'POST') type = 'pl_to_pl'
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: { ...noun(), type }, duplicateOf: null }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/cards/c1/typ',
      method: 'POST',
      body: { type: 'pl_to_pl' },
    })
    expect((await screen.findByText(t.typePlPl)).tagName).not.toBe('BUTTON')
  })

  it('says so when that card already exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              (init?.method ?? 'GET') === 'GET'
                ? { card: noun() }
                : { card: noun(), duplicateOf: 'other' },
            ),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeDuplicate)).toBeTruthy()
  })

  it('shows an error when the switch is refused', async () => {
    stubFailingWrites(noun, 400)
    render(<CardPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeFailed)).toBeTruthy()
  })


  // Forms are generated with the card now (spec §1); nothing asks for them.
  it('offers no "dodaj formy" control', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    await screen.findByDisplayValue('złośliwy')
    expect(screen.queryByText('dodaj formy')).toBeNull()
  })

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

  // wygeneruj ponownie now queues the rebuild and answers 202 at once (Task
  // 7); the outcome — including a duplicate clash — arrives later, through
  // the reloaded card, so there is no immediate duplicate notice to show.
  it('queues wygeneruj ponownie and shows generowanie… until the card is rebuilt', async () => {
    let generating = false
    let card = cardRow({ status: 'needs_input', promptText: null })
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          generating = true
          return Promise.resolve({
            ok: true,
            status: 202,
            json: () => Promise.resolve({ queued: true }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card, generating }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<CardPage />)
    const button = await screen.findByText(t.regenerate)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.generating)).toBeTruthy()

    card = cardRow({ status: 'ready', promptText: 'злобный' })
    generating = false
    expect(await screen.findByDisplayValue('злобный', undefined, { timeout: 4_000 })).toBeTruthy()
    expect(screen.queryByText(t.generating)).toBeNull()
  })

  it('disables the regenerate control while a job is in flight', async () => {
    stubFetch(() => cardRow({ status: 'needs_input', promptText: null }), true)
    render(<CardPage />)
    expect(await screen.findByText(t.generating)).toBeTruthy()
    expect((screen.getByText(t.regenerate) as HTMLButtonElement).disabled).toBe(true)
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

  it('offers suspend and discard as icon + word buttons', async () => {
    // same fetch stub as the suspend test above
    stubFetch(() => cardRow({ suspendedAt: null }))
    render(<CardPage />)
    const suspend = await screen.findByRole('button', { name: t.suspend })
    expect(suspend.querySelector('svg')).not.toBeNull()
    const discard = screen.getByRole('button', { name: t.moveToDiscarded })
    expect(discard.querySelector('svg')).not.toBeNull()
    expect(discard.className).toContain('text-red-600')
  })

  // Moving the card you are looking at to its topic's odrzucone would
  // otherwise leave this screen showing a card no longer in view.
  it('moves the card to odrzucone (DELETE) and returns to the list', async () => {
    const calls = stubFetch(() => cardRow())
    render(<CardPage />)
    const button = await screen.findByText(t.moveToDiscarded)
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

  // Re-recognition is gone — a wrong-language recording is deleted and
  // recorded again with the matching button on /dodaj, not repaired here.
  it('offers no language controls on the card detail page', async () => {
    stubFetch(() => cardRow())
    render(<CardPage />)
    await screen.findByDisplayValue('z\u0142o\u015bliwy')
    expect(screen.queryByText(t.asPolish)).toBeNull()
    expect(screen.queryByText(t.asRussian)).toBeNull()
  })

  // The topic link is now a move picker (spec 2026-09-19-topic-items §5.3):
  // choosing another topic PATCHes { topicId } and reloads the card so the
  // picker's `currentTopicId` and anything else topic-dependent catch up.
  it('offers a move picker for the card’s topic, and moves it on choosing another one', async () => {
    let topicId = 't1'
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (url === '/api/topics') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                topics: [
                  { id: 't1', name: 'U lekarza' },
                  { id: 't2', name: 'U mechanika' },
                ],
              }),
          }) as unknown as Promise<Response>
        }
        if (method === 'PATCH') {
          topicId = (JSON.parse(init!.body as string) as { topicId: string }).topicId
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ card: cardRow({ topicId }) }) }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ card: cardRow(), generating: false, topic: { id: topicId, name: topicId === 't1' ? 'U lekarza' : 'U mechanika' } }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<CardPage />)
    fireEvent.click(await screen.findByText(`${t.moveTo}: U lekarza`))
    fireEvent.click(await screen.findByText('U mechanika'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/cards/c1' && c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.url === '/api/cards/c1' && c.method === 'PATCH')!
    expect(patch.body).toEqual({ topicId: 't2' })
    // A reload follows the move: a fresh GET for the card picks up the new topic.
    await waitFor(() => expect(calls.filter((c) => c.url === `/api/cards/c1` && c.method === 'GET').length).toBeGreaterThan(1))
  })

  // The card page dropped its topic name entirely (whole-branch review
  // finding): the button always read `temat: …`, even for a card sitting
  // in Ogólne.
  it('shows the topic name — temat: Ogólne — for a card filed under Ogólne', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ card: cardRow({ topicId: 'default' }), generating: false, topic: { id: 'default', name: 'Ogólne' } }),
          }) as unknown as Promise<Response>,
      ),
    )
    render(<CardPage />)
    expect(await screen.findByText(`${t.moveTo}: Ogólne`)).toBeTruthy()
  })
})
