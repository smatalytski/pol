// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

// next/link needs an App Router context that a bare jsdom render has no way to
// provide. Rendering it as the anchor it becomes keeps the assertion honest:
// what is checked below is the href this page passes, which is the thing that
// can actually be wrong.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const CardsPage = (await import('./page')).default

function cardRow(over: Partial<CardRow> = {}): CardRow {
  return {
    id: 'c1',
    type: 'ru_to_pl',
    promptText: 'злобный',
    promptHint: null,
    answerPl: 'złośliwy',
    answerKey: 'złośliwy',
    examplePl: null,
    exampleRu: null,
    grammarNote: null,
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
    ...over,
  }
}

function stubFetch(rows: () => CardRow[]) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ cards: rows() }),
      }) as unknown as Promise<Response>
    }),
  )
  return calls
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CardsPage (browse list)', () => {
  it('lists the Polish title of each card', async () => {
    stubFetch(() => [cardRow({ id: 'a', answerPl: 'prać' }), cardRow({ id: 'b', answerPl: 'patrzeć' })])
    render(<CardsPage />)
    expect(await screen.findByText('prać')).toBeTruthy()
    expect(screen.getByText('patrzeć')).toBeTruthy()
  })

  // The point of the rewrite: the list is for finding a card, so it carries
  // Polish titles and nothing else. The Russian prompt and every editable
  // field moved to the detail screen, which is why the only textbox left here
  // is the search field.
  it('shows no Russian and no editable fields, only the search box', async () => {
    stubFetch(() => [cardRow()])
    render(<CardsPage />)
    await screen.findByText('złośliwy')
    expect(screen.queryByText('злобный')).toBeNull()
    expect(screen.queryByDisplayValue('złośliwy')).toBeNull()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('links each title to that card detail page', async () => {
    stubFetch(() => [cardRow({ id: 'abc', answerPl: 'prać' })])
    render(<CardsPage />)
    const link = await screen.findByText('prać')
    expect(link.closest('a')?.getAttribute('href')).toBe('/fiszki/abc')
  })

  it('badges only the card that still needs a prompt', async () => {
    stubFetch(() => [
      cardRow({ id: 'a', status: 'needs_input', answerPl: 'prać' }),
      cardRow({ id: 'b', status: 'ready', answerPl: 'patrzeć' }),
    ])
    render(<CardsPage />)
    await waitFor(() => expect(screen.getByText('patrzeć')).toBeTruthy())
    expect(screen.getAllByText(t.needsInput)).toHaveLength(1)
    expect(screen.getByText(t.needsInput).closest('li')).toBe(screen.getByText('prać').closest('li'))
  })

  // Without a marker a suspended card is indistinguishable from an active one,
  // leaving no way to see why it never comes up in review.
  it('marks a suspended card', async () => {
    stubFetch(() => [
      cardRow({ id: 'a', suspendedAt: 123, answerPl: 'prać' }),
      cardRow({ id: 'b', suspendedAt: null, answerPl: 'patrzeć' }),
    ])
    render(<CardsPage />)
    await waitFor(() => expect(screen.getByText('patrzeć')).toBeTruthy())
    expect(screen.getAllByText(t.suspended)).toHaveLength(1)
    expect(screen.getByText(t.suspended).closest('li')).toBe(screen.getByText('prać').closest('li'))
  })

  it('badges a forms-only card', async () => {
    stubFetch(() => [
      cardRow({ id: 'a', type: 'pl_to_pl', answerPl: 'kot' }),
      cardRow({ id: 'b', type: 'ru_to_pl', answerPl: 'pies' }),
    ])
    render(<CardsPage />)
    await screen.findByText('pies')
    expect(screen.getAllByText(t.formsBadge)).toHaveLength(1)
    expect(screen.getByText(t.formsBadge).closest('li')).toBe(screen.getByText('kot').closest('li'))
  })

  it('passes the typed query to the search endpoint', async () => {
    const calls = stubFetch(() => [cardRow()])
    render(<CardsPage />)
    await screen.findByText('złośliwy')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'prać' } })
    await waitFor(() => expect(calls).toContain(`/api/cards?q=${encodeURIComponent('prać')}`))
  })
})
