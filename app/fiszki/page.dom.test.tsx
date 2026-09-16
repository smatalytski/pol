// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CardsPage from './page'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

function cardRow(over: Partial<CardRow> = {}): CardRow {
  return {
    id: 'c1',
    type: 'ru_to_pl',
    promptText: 'злобный',
    promptHint: null,
    promptMediaId: null,
    answerPl: 'złośliwy',
    answerKey: 'złośliwy',
    examplePl: null,
    exampleRu: null,
    grammarNote: null,
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

function stubFetch(rows: () => CardRow[]) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') return Promise.resolve({ json: () => Promise.resolve({ cards: rows() }) }) as unknown as Promise<Response>
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }) as unknown as Promise<Response>
    }),
  )
  return calls
}

describe('CardsPage (browse/edit)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('lists cards returned by the search endpoint', async () => {
    stubFetch(() => [cardRow()])
    render(<CardsPage />)
    expect(await screen.findByDisplayValue('złośliwy')).toBeTruthy()
  })

  it('shows a needs_input badge only for cards missing a prompt', async () => {
    stubFetch(() => [cardRow({ id: 'a', status: 'needs_input' }), cardRow({ id: 'b', status: 'ready' })])
    render(<CardsPage />)
    await waitFor(() => expect(screen.getAllByDisplayValue('złośliwy')).toHaveLength(2))
    expect(screen.getAllByText(t.needsInput)).toHaveLength(1)
  })

  it('PATCHes the edited answer on blur, but only when it actually changed', async () => {
    const calls = stubFetch(() => [cardRow()])
    render(<CardsPage />)
    const input = await screen.findByDisplayValue('złośliwy')

    fireEvent.blur(input) // unchanged — must not PATCH
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    fireEvent.change(input, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall?.url).toBe('/api/cards/c1')
    expect(patchCall?.body).toEqual({ answerPl: 'wredny' })
  })

  it('POSTs to the formy route when "dodaj formy" is clicked', async () => {
    const calls = stubFetch(() => [cardRow()])
    render(<CardsPage />)
    const button = await screen.findByText(t.addForms)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.some((c) => c.url === '/api/cards/c1/formy' && c.method === 'POST')).toBe(true)
  })

  // Minor review finding: this test only ever exercised the suspend
  // direction (a live card clicking "zawieś") and asserted only that
  // suspendedAt was "a number", not the unsuspend direction it claims to
  // cover in its own name. Split into two, each pinning the exact PATCH body
  // for its direction — a live card must send a number, a suspended one must
  // send exactly `null`, not merely "not a number".
  it('sends a numeric suspendedAt when suspending a live card', async () => {
    const calls = stubFetch(() => [cardRow({ suspendedAt: null })])
    render(<CardsPage />)
    const button = await screen.findByText(t.suspend)
    await act(async () => {
      fireEvent.click(button)
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(typeof (patchCall?.body as { suspendedAt: number }).suspendedAt).toBe('number')
  })

  it('sends suspendedAt: null when unsuspending an already-suspended card', async () => {
    const calls = stubFetch(() => [cardRow({ suspendedAt: 123 })])
    render(<CardsPage />)
    const button = await screen.findByText(t.unsuspend)
    await act(async () => {
      fireEvent.click(button)
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall?.body).toEqual({ suspendedAt: null })
  })

  it('DELETEs the card when the delete control is clicked', async () => {
    const calls = stubFetch(() => [cardRow()])
    render(<CardsPage />)
    const button = await screen.findByText(t.deleteItem)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.some((c) => c.url === '/api/cards/c1' && c.method === 'DELETE')).toBe(true)
  })

  // Critical finding from review: an <input>'s value-sanitization algorithm
  // strips CR/LF, so a pl_forms answer's real newlines never survive being
  // put into an editable <input>'s defaultValue. Any focus+blur on that field
  // — even with no real edit — would PATCH the flattened, newline-free string
  // over the only copy of the table (captures.generationJson holds dictated
  // cards, not forms cards), destroying it irreversibly. Forms answers must
  // render read-only, through the same FormsTable review uses, not through an
  // editable <input> at all.
  const FORMS_MARKDOWN = '| a | b |\n|---|---|\n| 1 | 2 |'

  it('renders a pl_forms answer read-only through FormsTable, never as an editable <input>', async () => {
    stubFetch(() => [cardRow({ type: 'pl_forms', answerPl: FORMS_MARKDOWN })])
    render(<CardsPage />)
    const table = await screen.findByRole('table')
    expect(table).toBeTruthy()
    // Nothing anywhere on the row holds the raw Markdown as an editable
    // value — that's the whole point (an <input>'s value-sanitization would
    // silently flatten its newlines the moment it round-trips through one).
    // A separate, unrelated promptText input existing on the same row (added
    // for the needs_input fix) is fine and expected; it is not the answer.
    expect(screen.queryByDisplayValue(FORMS_MARKDOWN)).toBeNull()
  })

  it('never PATCHes a pl_forms row on blur, since there is no editable answer field to blur', async () => {
    const calls = stubFetch(() => [cardRow({ type: 'pl_forms', answerPl: FORMS_MARKDOWN })])
    render(<CardsPage />)
    await screen.findByRole('table')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  // Important review finding: a needs_input card (produced ONLY by a failed
  // generation — exactly when it can't be fixed immediately) had no durable
  // way to get its prompt filled in. Browse rendered promptText as a plain,
  // non-editable <span>, and the only prompt editor lived in the capture
  // chip, reachable only inside /dodaj's 60-second `since` window. Past that
  // window the card was permanently stuck out of review.
  it('lets promptText be edited from the browse row, promoting a needs_input card once filled in', async () => {
    const calls = stubFetch(() => [cardRow({ status: 'needs_input', promptText: null })])
    render(<CardsPage />)
    const promptInput = await screen.findByPlaceholderText(t.needsInput)
    fireEvent.change(promptInput, { target: { value: 'злобный' } })
    await act(async () => {
      fireEvent.blur(promptInput)
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall?.body).toEqual({ promptText: 'злобный' })
  })

  // Important review finding: createFormsCard now rejects a pl_forms parent
  // (lib/cards/service.ts), but the button was still offered on those rows —
  // one tap would burn a model call on a nonsense request before hitting that
  // rejection. Hide it too, not instead of the service-level guard.
  it('does not offer "dodaj formy" on a pl_forms row', async () => {
    stubFetch(() => [cardRow({ type: 'pl_forms', answerPl: FORMS_MARKDOWN })])
    render(<CardsPage />)
    await screen.findByRole('table')
    expect(screen.queryByText(t.addForms)).toBeNull()
  })

  // Important review finding: the route now returns a real error status/body
  // on a generation failure, but the page ignored it — `.then(() => load(q))`
  // checks neither `res.ok` nor shows anything, so on the likeliest real
  // outcome (a generation failure — precisely what this task's own sandbox
  // produced), the button appeared to do nothing.
  it('shows an error when generating forms fails, instead of silently doing nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/cards?q=') {
          return Promise.resolve({ json: () => Promise.resolve({ cards: [cardRow()] }) }) as unknown as Promise<Response>
        }
        if (url === '/api/cards/c1/formy' && init?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: 'boom' }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<CardsPage />)
    const button = await screen.findByText(t.addForms)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.formsFailed)).toBeTruthy()
  })

  // Important review finding (A3): patch()/the delete button ignored the
  // response status entirely. Since the answer field is an uncontrolled
  // `defaultValue` input, a rejected PATCH left the user's edit on screen
  // looking saved.
  it('shows an error when a PATCH is rejected, instead of silently reloading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/cards?q=') {
          return Promise.resolve({ json: () => Promise.resolve({ cards: [cardRow()] }) }) as unknown as Promise<Response>
        }
        if (url === '/api/cards/c1' && init?.method === 'PATCH') {
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'bad' }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<CardsPage />)
    const input = await screen.findByDisplayValue('złośliwy')
    fireEvent.change(input, { target: { value: 'wredny' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(await screen.findByText(t.saveFailed)).toBeTruthy()
  })

  it('shows an error when a DELETE is rejected, instead of silently reloading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/cards?q=') {
          return Promise.resolve({ json: () => Promise.resolve({ cards: [cardRow()] }) }) as unknown as Promise<Response>
        }
        if (url === '/api/cards/c1' && init?.method === 'DELETE') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<CardsPage />)
    const button = await screen.findByText(t.deleteItem)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.saveFailed)).toBeTruthy()
  })
})
