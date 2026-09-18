// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReviewPage from './page'
import { t } from '@/i18n/pl'

type QueueItem = {
  id: string
  type: 'ru_to_pl'
  promptText: string
  promptHint: null
  answerPl: string
  examplePl: null
  grammarNote: null
  wordKind: null
  forms: null
  isNew: boolean
}

function card(id: string, promptText: string): QueueItem {
  return {
    id,
    type: 'ru_to_pl',
    promptText,
    promptHint: null,
    answerPl: `answer-${id}`,
    examplePl: null,
    grammarNote: null,
    wordKind: null,
    forms: null,
    isNew: false,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReviewPage', () => {
  // A fast double-tap on a rating button must record exactly one review, not
  // two — rating is not idempotent, so two dispatches from one tap would
  // silently push the card twice as far out. This asserts the observable
  // consequence (one POST, queue advances by exactly one card) rather than
  // reaching into the ref guard directly.
  it('records only one review from two rapid clicks on the same rating button', async () => {
    const rateCalls: string[] = []
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/review/queue') {
        return Promise.resolve({
          json: () => Promise.resolve({ cards: [card('a', 'AAA'), card('b', 'BBB')], nextDue: null }),
        } as Response)
      }
      if (typeof url === 'string' && url.startsWith('/api/review/') && url !== '/api/review/undo' && init?.method === 'POST') {
        rateCalls.push(url)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ due: 123 }) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }) as unknown as typeof fetch

    render(<ReviewPage />)
    await waitFor(() => screen.getByText('AAA'))
    fireEvent.click(screen.getByRole('button', { name: 'pokaż' }))
    const goodButton = await screen.findByRole('button', { name: 'dobrze' })

    // Both clicks dispatched inside one `act` so neither triggers a
    // re-render before the other's handler runs — this is what a genuine
    // same-tick double-tap looks like, as opposed to two separate `act`
    // blocks which would let React commit the queue-advance in between and
    // make the second click land on a different (or absent) button.
    act(() => {
      fireEvent.click(goodButton)
      fireEvent.click(goodButton)
    })

    await waitFor(() => screen.getByText('BBB'))
    expect(rateCalls).toEqual(['/api/review/a'])
  })

  // undoLastReview acts on the globally-last non-undone review row, with no
  // notion of which client asked. If a second writer's rating becomes the
  // globally-last row between this client's optimistic restore and the
  // server's response, `d.undone.cardId` won't match what this client
  // expected — the fix must detect that and reload from server truth rather
  // than leave the wrong card showing.
  it('reconciles from the server when undo reverts a different card than expected', async () => {
    let queueCall = 0
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/review/queue') {
        queueCall += 1
        if (queueCall === 1) {
          return Promise.resolve({
            json: () => Promise.resolve({ cards: [card('a', 'AAA'), card('b', 'BBB')], nextDue: null }),
          } as Response)
        }
        // Reconciliation fetch: server truth after the mismatched undo.
        return Promise.resolve({
          json: () => Promise.resolve({ cards: [card('c', 'CCC')], nextDue: null }),
        } as Response)
      }
      if (url === '/api/review/undo' && init?.method === 'POST') {
        // A different card than the one this client rated — simulating a
        // second writer's review having become the globally-last row.
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ undone: { cardId: 'z-other' } }) } as Response)
      }
      if (typeof url === 'string' && url.startsWith('/api/review/') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ due: 123 }) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }) as unknown as typeof fetch

    render(<ReviewPage />)
    await waitFor(() => screen.getByText('AAA'))
    fireEvent.click(screen.getByRole('button', { name: 'pokaż' }))
    fireEvent.click(await screen.findByRole('button', { name: 'dobrze' }))

    // Now viewing card b, with "cofnij" available since a rating was just made.
    await waitFor(() => screen.getByText('BBB'))
    fireEvent.click(screen.getByRole('button', { name: 'cofnij' }))

    // Optimistic UI shows card a again immediately...
    await waitFor(() => screen.getByText('AAA'))
    // ...but once the mismatched response is reconciled, card c (the
    // server's actual truth) replaces it. Card a must not linger.
    await waitFor(() => screen.getByText('CCC'))
    expect(screen.queryByText('AAA')).toBeNull()
  })

  // Important review finding (A3): the rating POST's response was never
  // checked. The optimistic UI had already moved past the card by the time
  // the rejection arrived, so the user had no way to know their rating never
  // reached the server.
  it('shows an error when the rating POST is rejected by the server', async () => {
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/review/queue') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cards: [card('a', 'AAA')], nextDue: null }),
        } as Response)
      }
      if (typeof url === 'string' && url.startsWith('/api/review/') && init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }) as unknown as typeof fetch

    render(<ReviewPage />)
    await waitFor(() => screen.getByText('AAA'))
    fireEvent.click(screen.getByRole('button', { name: 'pokaż' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'dobrze' }))
    })
    expect(await screen.findByText(t.rateFailed)).toBeTruthy()
  })
})
