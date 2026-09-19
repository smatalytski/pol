// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 't1' }) }))

const TopicPage = (await import('./page')).default

function view(over = {}) {
  return {
    topic: { id: 't1', name: 'U lekarza', context: 'z dzieckiem, grypa', suspendedAt: null, createdAt: 1 },
    state: 'ready',
    error: null,
    round: 1,
    items: [
      { id: 's1', answerPl: 'gorączka', glossRu: 'температура, жар', kind: 'slowo' },
      { id: 's2', answerPl: 'ma gorączkę od wczoraj', glossRu: 'у него температура со вчера', kind: 'fraza' },
    ],
    cards: [],
    pending: [],
    ...over,
  }
}

function stubFetch(v: () => unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = init?.method === 'POST' ? { accepted: 1, nextJobId: null, jobId: 'j' } : v()
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) }) as unknown as Promise<Response>
  }))
  return calls
}

const posts = (calls: { url: string; init?: RequestInit }[]) => calls.filter((c) => c.init?.method === 'POST')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TopicPage', () => {
  it('shows the round as Polish with its Russian gloss', async () => {
    stubFetch(() => view())
    render(<TopicPage />)
    expect(await screen.findByText('gorączka')).toBeTruthy()
    expect(screen.getByText('температура, жар')).toBeTruthy()
    expect(screen.getByText(t.kindPhrase)).toBeTruthy()
  })

  it('strikes an item out and restores it on a second tap', async () => {
    stubFetch(() => view())
    render(<TopicPage />)
    const item = (await screen.findByText('gorączka')).closest('button')!
    fireEvent.click(item)
    expect(item.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(item)
    expect(item.getAttribute('aria-pressed')).toBe('false')
  })

  it('accepts the rest and finishes', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    fireEvent.click((await screen.findByText('gorączka')).closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0].url).toBe('/api/topics/t1/rounds/1')
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: ['s1'] })
  })

  it('accepts the rest and asks for another round with the chosen settings', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    await screen.findByText('gorączka')
    fireEvent.click(screen.getByRole('button', { name: t.mixWords }))
    fireEvent.click(screen.getByRole('button', { name: t.more }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: [], next: { count: 10, mix: 'slowa', level: 'zaawansowany' } })
  })

  it('offers only "more" once the round is decided', async () => {
    const calls = stubFetch(() => view({ state: 'idle', items: [] }))
    render(<TopicPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.more }))
    expect(screen.queryByRole('button', { name: t.addItem })).toBeNull()
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(JSON.parse(String(posts(calls)[0].init!.body))).toEqual({ rejected: [], next: { count: 10, mix: 'mieszane', level: 'zaawansowany' } })
  })

  it('says it is searching while a round is in flight', async () => {
    stubFetch(() => view({ state: 'searching', items: [] }))
    render(<TopicPage />)
    expect(await screen.findByText(t.searching)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.more })).toBeNull()
  })

  it('shows a failed round with its error and a retry', async () => {
    const calls = stubFetch(() => view({ state: 'failed', error: 'unusable payload', items: [] }))
    render(<TopicPage />)
    expect(await screen.findByText('unusable payload')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.tryAgain }))
    await waitFor(() => expect(posts(calls).map((c) => c.url)).toEqual(['/api/topics/t1/retry']))
  })

  it('lists pending items above the topic’s cards', async () => {
    stubFetch(() =>
      view({
        pending: [{ id: 'c1', transcript: 'osłuchać', status: 'queued' }],
        cards: [{ id: 'k1', answerPl: 'katar', status: 'ready', suspendedAt: null, type: 'ru_to_pl' }],
      }),
    )
    render(<TopicPage />)
    expect(await screen.findByText('osłuchać')).toBeTruthy()
    expect(screen.getByText('katar').closest('a')?.getAttribute('href')).toBe('/fiszki/k1')
  })

  // spec §4.4: the topic's cards render "in the same rows as /fiszki" — a
  // suspended or needs-input card must carry the same badge here as there,
  // not look like a normal, ready card.
  it('badges a suspended card and one that needs input, like /fiszki', async () => {
    stubFetch(() =>
      view({
        cards: [
          { id: 'k1', answerPl: 'katar', status: 'ready', suspendedAt: 123, type: 'ru_to_pl' },
          { id: 'k2', answerPl: 'kaszel', status: 'needs_input', suspendedAt: null, type: 'ru_to_pl' },
        ],
      }),
    )
    render(<TopicPage />)
    expect(await screen.findByText(t.suspended)).toBeTruthy()
    expect(screen.getByText(t.suspended).closest('li')).toBe(screen.getByText('katar').closest('li'))
    expect(screen.getByText(t.needsInput)).toBeTruthy()
    expect(screen.getByText(t.needsInput).closest('li')).toBe(screen.getByText('kaszel').closest('li'))
  })

  // A card in a switched-off topic is out of review just like an
  // individually suspended one (spec §3.5), and the topic page must say so
  // on every card row, "the same rows as /fiszki".
  it('badges every card when the topic itself is switched off', async () => {
    stubFetch(() =>
      view({
        topic: { id: 't1', name: 'U lekarza', context: 'x', suspendedAt: 123, createdAt: 1 },
        cards: [{ id: 'k1', answerPl: 'katar', status: 'ready', suspendedAt: null, type: 'ru_to_pl' }],
      }),
    )
    render(<TopicPage />)
    expect(await screen.findByText(t.topicOff)).toBeTruthy()
    expect(screen.getByText(t.topicOff).closest('li')).toBe(screen.getByText('katar').closest('li'))
  })

  it('switches the topic off', async () => {
    const calls = stubFetch(() => view())
    render(<TopicPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.topicOn }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
  })

  it('says so for an unknown topic', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    render(<TopicPage />)
    expect(await screen.findByText(t.topicNotFound)).toBeTruthy()
  })

  // Controller ruling (carried over from Task 10's review): only a 404 means
  // "not found" — any other non-2xx, malformed body or network error must
  // not claim the topic doesn't exist, must not crash, and must never
  // produce an unhandled rejection, whether on the first load or a poll.
  it('shows a load error rather than "not found" for a non-404 failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }))
    render(<TopicPage />)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('shows a load error rather than "not found" for a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))
    render(<TopicPage />)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('shows a load error rather than "not found" when fetch rejects, without an unhandled rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<TopicPage />)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('keeps the previous view on screen and shows an error when a reload after an action fails', async () => {
    let gets = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ accepted: 1, nextJobId: null, jobId: 'j' }) })
      gets++
      if (gets === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(view({ state: 'failed', error: 'unusable payload', items: [] })) })
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
    }))
    render(<TopicPage />)
    expect(await screen.findByText('unusable payload')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.tryAgain }))
    await waitFor(() => expect(screen.getByText(t.topicsLoadFailed)).toBeTruthy())
    // the stale view (still "failed", with its retry button) stays on screen
    expect(screen.getByText('unusable payload')).toBeTruthy()
  })

  it('shows a save error when a rename fails with a non-2xx status (not just a network error)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve(view()) })
    }))
    render(<TopicPage />)
    const input = await screen.findByDisplayValue('U lekarza')
    fireEvent.change(input, { target: { value: 'Nowa nazwa' } })
    fireEvent.blur(input)
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
  })
})
