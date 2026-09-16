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

  it('toggles suspend/unsuspend with the right patch body depending on current state', async () => {
    const calls = stubFetch(() => [cardRow({ suspendedAt: null })])
    render(<CardsPage />)
    const button = await screen.findByText(t.suspend)
    await act(async () => {
      fireEvent.click(button)
    })
    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall?.body).toHaveProperty('suspendedAt')
    expect(typeof (patchCall?.body as { suspendedAt: number }).suspendedAt).toBe('number')
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
})
