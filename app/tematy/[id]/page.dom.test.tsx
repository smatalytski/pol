// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionState } from '@/components/SessionState'
import { t } from '@/i18n/pl'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 't1' }) }))

const TopicPage = (await import('./page')).default

const card = (id: string, answerPl: string, over = {}) => ({
  id,
  answerPl,
  status: 'ready',
  suspendedAt: null,
  type: 'ru_to_pl',
  topicId: 't1',
  ...over,
})

const item = (id: string, answerPl: string, over = {}) => ({
  id,
  answerPl,
  glossRu: null,
  kind: null,
  source: 'suggested',
  level: null,
  ...over,
})

function view(over: Record<string, unknown> = {}, groups: Record<string, unknown> = {}) {
  return {
    topic: { id: 't1', name: 'U lekarza', context: 'z dzieckiem, grypa', suspendedAt: null, createdAt: 1, isDefault: false },
    groups: {
      carded: [card('k1', 'katar')],
      open: [
        item('i1', 'gorączka', { glossRu: 'температура, жар', kind: 'slowo' }),
        item('i2', 'ma gorączkę od wczoraj', { kind: 'fraza', level: 'sredni' }),
      ],
      discarded: [
        { kind: 'item', at: 3, item: item('i3', 'kaszel') },
        { kind: 'card', at: 2, card: card('k9', 'wysypka') },
      ],
      ...groups,
    },
    pending: [],
    batch: { state: 'idle', error: null },
    ...over,
  }
}

type Call = { url: string; method: string; body: unknown }
type Reply = { status: number; body: unknown }

/**
 * A URL- and method-aware fetch: `GET /api/topics/t1` answers with `v()`,
 * `GET /api/topics` with the move picker's list, and anything else with
 * `routes['METHOD url']` or a plain 200 `{ ok: true }`.
 */
function stubFetch(v: () => unknown, routes: Record<string, Reply> = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const key = `${method} ${url}`
      let reply: Reply = { status: 200, body: { ok: true } }
      if (routes[key]) reply = routes[key]
      else if (key === 'GET /api/topics/t1') reply = { status: 200, body: v() }
      else if (key === 'GET /api/topics')
        reply = {
          status: 200,
          body: { topics: [{ id: 't1', name: 'U lekarza' }, { id: 't2', name: 'W sklepie' }] },
        }
      return Promise.resolve({
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: () => Promise.resolve(reply.body),
      }) as unknown as Promise<Response>
    }),
  )
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')
const tab = (label: string, n: number) => screen.findByRole('button', { name: `${label} (${n})` })
const row = (text: string) => screen.getByText(text).closest('li') as HTMLElement

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('TopicPage', () => {
  it('counts each group in its tab, pending included in "z kartą"', async () => {
    stubFetch(() => view({ pending: [{ id: 'c1', transcript: 'osłuchać', status: 'queued' }] }))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await tab(t.tabCarded, 2)).toBeTruthy()
    expect(screen.getByRole('button', { name: `${t.tabOpen} (2)` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${t.tabDiscarded} (2)` })).toBeTruthy()
  })

  it('opens on "bez karty" when the topic has open items', async () => {
    stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    expect((await tab(t.tabOpen, 2)).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('gorączka')).toBeTruthy()
  })

  it('opens on "z kartą" when there are no open items', async () => {
    stubFetch(() => view({}, { open: [] }))
    render(<SessionState><TopicPage /></SessionState>)
    expect((await tab(t.tabCarded, 1)).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('katar')).toBeTruthy()
  })

  it('opens on the tab last used for this topic, and remembers a new choice', async () => {
    localStorage.setItem('fiszki:tab:t1', 'discarded')
    stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    expect((await tab(t.tabDiscarded, 2)).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('kaszel')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: `${t.tabCarded} (1)` }))
    expect(localStorage.getItem('fiszki:tab:t1')).toBe('carded')
    expect(screen.getByText('katar')).toBeTruthy()
  })

  it('lists pending captures above the cards, and ✕ on a card deletes it', async () => {
    localStorage.setItem('fiszki:tab:t1', 'carded')
    const calls = stubFetch(() => view({ pending: [{ id: 'c1', transcript: 'osłuchać', status: 'generating' }] }))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText('osłuchać')).toBeTruthy()
    expect(within(row('osłuchać')).getByText(t.generating)).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items.indexOf(row('osłuchać'))).toBeLessThan(items.indexOf(row('katar')))
    expect(screen.getByText('katar').closest('a')?.getAttribute('href')).toBe('/fiszki/k1')
    fireEvent.click(within(row('katar')).getByRole('button', { name: t.discard }))
    await waitFor(() => expect(writes(calls)).toEqual([{ url: '/api/cards/k1', method: 'DELETE', body: undefined }]))
  })

  it('moves a card to another topic', async () => {
    localStorage.setItem('fiszki:tab:t1', 'carded')
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('katar')
    fireEvent.click(within(row('katar')).getByRole('button', { name: t.moveTo }))
    fireEvent.click(await screen.findByRole('button', { name: 'W sklepie' }))
    await waitFor(() => expect(writes(calls)).toEqual([{ url: '/api/cards/k1', method: 'PATCH', body: { topicId: 't2' } }]))
  })

  it('shows an item with its gloss, kind and level badge', async () => {
    stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText('gorączka')).toBeTruthy()
    expect(within(row('gorączka')).getByText(/температура, жар/)).toBeTruthy()
    expect(within(row('gorączka')).getByText(t.kindWord)).toBeTruthy()
    expect(within(row('gorączka')).queryByText(t.levelBadge)).toBeNull()
    expect(within(row('ma gorączkę od wczoraj')).getByText(t.kindPhrase)).toBeTruthy()
    expect(within(row('ma gorączkę od wczoraj')).getByText(t.levelBadge)).toBeTruthy()
    expect(within(row('ma gorączkę od wczoraj')).queryByText(/—/)).toBeNull()
  })

  it('splits an item row into a title line and a right-aligned controls line', async () => {
    stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    const li = row('gorączka')
    const controls = within(li).getByRole('button', { name: t.makeCard }).parentElement!
    expect(li.children.length).toBe(2)
    expect(li.children[1]).toBe(controls)
    expect(controls.className).toContain('justify-end')
    expect(li.className).toContain('relative')
  })

  it('makes a card of an item', async () => {
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.makeCard }))
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/topics/t1/items/i1/card']))
  })

  it('discards an item', async () => {
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.discard }))
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/topics/t1/items/i1/discard']))
  })

  it('moves an item to another topic', async () => {
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.moveTo }))
    fireEvent.click(await screen.findByRole('button', { name: 'W sklepie' }))
    await waitFor(() =>
      expect(writes(calls)).toEqual([{ url: '/api/topics/t1/items/i1', method: 'PATCH', body: { topicId: 't2' } }]),
    )
  })

  it('disables a row’s buttons while its action is in flight, then reloads', async () => {
    let release!: () => void
    const calls = stubFetch(() => view())
    const base = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<void>((r) => (release = r)).then(() => base(url, init))
      return base(url, init)
    }))
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.makeCard }))
    await waitFor(() => expect((within(row('gorączka')).getByRole('button', { name: t.discard }) as HTMLButtonElement).disabled).toBe(true))
    expect((within(row('ma gorączkę od wczoraj')).getByRole('button', { name: t.discard }) as HTMLButtonElement).disabled).toBe(false)
    const gets = calls.filter((c) => c.method === 'GET').length
    release()
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(gets))
    await waitFor(() => expect((within(row('gorączka')).getByRole('button', { name: t.discard }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('shows a save error when an action fails, leaving the list as it was', async () => {
    stubFetch(() => view(), { 'POST /api/topics/t1/items/i1/discard': { status: 500, body: { error: 'boom' } } })
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.discard }))
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.getByText('gorączka')).toBeTruthy()
  })

  it('adds an item by hand', async () => {
    const calls = stubFetch(() => view(), { 'POST /api/topics/t1/cards': { status: 202, body: { item: item('i4', 'recepta'), captureId: 'c1' } } })
    render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
    fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
    fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'recepta' } })
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    await waitFor(() => expect(writes(calls)).toEqual([{ url: '/api/topics/t1/cards', method: 'POST', body: { text: 'recepta' } }]))
  })

  it('shows the server’s message when a hand-added item is a duplicate', async () => {
    stubFetch(() => view(), { 'POST /api/topics/t1/cards': { status: 409, body: { error: 'już masz — w temacie Ogólne' } } })
    render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
    fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
    fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'katar' } })
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    expect(await screen.findByText('już masz — w temacie Ogólne')).toBeTruthy()
  })

  it('shows a Polish save error, not the English 400 text, when a hand-added item is rejected', async () => {
    stubFetch(() => view(), { 'POST /api/topics/t1/cards': { status: 400, body: { error: 'empty' } } })
    render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
    fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
    fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: '?' } })
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
    expect(screen.queryByText('empty')).toBeNull()
  })

  it('offers the hand-add on z kartą, not on bez karty', async () => {
    stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabOpen) }))
    expect(screen.queryByRole('button', { name: t.manualAdd })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t.tabCarded) }))
    expect(screen.getByRole('button', { name: t.manualAdd })).toBeTruthy()
  })

  it('keeps the bar shut until + is tapped, and posts to /cards', async () => {
    const calls = stubFetch(() => view(), { 'POST /api/topics/t1/cards': { status: 202, body: { item: item('i4', 'recepta'), captureId: 'c1' } } })
    render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
    // Not queryByLabelText: the "+" trigger itself carries aria-label={t.manualAdd},
    // so that query would match it too. This checks for the bar's actual input.
    expect(screen.queryByRole('textbox', { name: t.manualAdd })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
    fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'recepta' } })
    fireEvent.click(screen.getByRole('button', { name: t.addItem }))

    await waitFor(() =>
      expect(writes(calls)).toContainEqual({ url: '/api/topics/t1/cards', method: 'POST', body: { text: 'recepta' } }),
    )
  })

  it('keeps a half-typed word across a trip to another screen', async () => {
    stubFetch(() => view())
    const page = render(<SessionState><TopicPage /></SessionState>)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t.tabCarded) }))
    fireEvent.click(screen.getByRole('button', { name: t.manualAdd }))
    fireEvent.change(screen.getByLabelText(t.manualAdd), { target: { value: 'recep' } })

    page.rerender(<SessionState><span /></SessionState>)
    page.rerender(<SessionState><TopicPage /></SessionState>)

    expect((await screen.findByLabelText(t.manualAdd) as HTMLInputElement).value).toBe('recep')
  })

  it('restores a discarded item', async () => {
    localStorage.setItem('fiszki:tab:t1', 'discarded')
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('kaszel')
    expect(within(row('kaszel')).queryByText(t.cardBadge)).toBeNull()
    fireEvent.click(within(row('kaszel')).getByRole('button', { name: t.restore }))
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/topics/t1/items/i3/restore']))
  })

  it('restores a discarded card, marked as a card', async () => {
    localStorage.setItem('fiszki:tab:t1', 'discarded')
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('wysypka')
    expect(within(row('wysypka')).getByText(t.cardBadge)).toBeTruthy()
    fireEvent.click(within(row('wysypka')).getByRole('button', { name: t.restore }))
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/cards/k9/restore']))
  })

  it('shows the server’s message when a restored card would be a duplicate', async () => {
    localStorage.setItem('fiszki:tab:t1', 'discarded')
    stubFetch(() => view(), { 'POST /api/cards/k9/restore': { status: 409, body: { error: 'już masz — w temacie Ogólne' } } })
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('wysypka')
    fireEvent.click(within(row('wysypka')).getByRole('button', { name: t.restore }))
    expect(await screen.findByText('już masz — w temacie Ogólne')).toBeTruthy()
    expect(screen.getByText('wysypka')).toBeTruthy()
  })

  it('asks for a batch with the chosen settings', async () => {
    const calls = stubFetch(() => view(), { 'POST /api/topics/t1/batches': { status: 202, body: { jobId: 'j' } } })
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(screen.getByRole('button', { name: t.mixWords }))
    fireEvent.click(screen.getByRole('button', { name: t.levelIntermediate }))
    fireEvent.click(screen.getByRole('button', { name: t.more }))
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        { url: '/api/topics/t1/batches', method: 'POST', body: { count: 10, mix: 'slowa', level: 'sredni' } },
      ]),
    )
  })

  it('has no batch controls, no context editor and a fixed name for the default topic', async () => {
    stubFetch(() =>
      view({ topic: { id: 't1', name: 'Ogólne', context: '', suspendedAt: null, createdAt: 1, isDefault: true } }),
    )
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    expect(screen.queryByRole('button', { name: t.more })).toBeNull()
    expect(screen.queryByRole('button', { name: t.mixWords })).toBeNull()
    expect((screen.getByDisplayValue('Ogólne') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByText(t.topicContext)).toBeNull()
    expect(screen.getByRole('switch', { name: t.topicOn })).toBeTruthy()
  })

  it('says it is searching while a batch runs', async () => {
    stubFetch(() => view({ batch: { state: 'searching', error: null } }))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText(t.searching)).toBeTruthy()
  })

  it('shows a failed batch with its error and a retry', async () => {
    const calls = stubFetch(() => view({ batch: { state: 'failed', error: 'unusable payload' } }))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText('unusable payload')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.tryAgain }))
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/topics/t1/retry']))
  })

  it('switches the topic off', async () => {
    const calls = stubFetch(() => view())
    render(<SessionState><TopicPage /></SessionState>)
    const toggle = await screen.findByRole('switch', { name: t.topicOn })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['PATCH /api/topics/t1']))
  })

  it('shows a save error when a rename fails with a non-2xx status', async () => {
    stubFetch(() => view(), { 'PATCH /api/topics/t1': { status: 500, body: {} } })
    render(<SessionState><TopicPage /></SessionState>)
    const input = await screen.findByDisplayValue('U lekarza')
    fireEvent.change(input, { target: { value: 'Nowa nazwa' } })
    fireEvent.blur(input)
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
  })

  it('says so for an unknown topic', async () => {
    stubFetch(() => view(), { 'GET /api/topics/t1': { status: 404, body: {} } })
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText(t.topicNotFound)).toBeTruthy()
  })

  // Only a 404 means "not found" — any other non-2xx, malformed body or
  // network error must not claim the topic doesn't exist, must not crash,
  // and must never produce an unhandled rejection, on a first load or a poll.
  it('shows a load error rather than "not found" for a non-404 failure', async () => {
    stubFetch(() => view(), { 'GET /api/topics/t1': { status: 500, body: {} } })
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('shows a load error rather than "not found" for a malformed body', async () => {
    stubFetch(() => ({}))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('shows a load error rather than "not found" when fetch rejects, without an unhandled rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<SessionState><TopicPage /></SessionState>)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.queryByText(t.topicNotFound)).toBeNull()
  })

  it('keeps the last view on screen and shows a load error when a reload after an action fails', async () => {
    let gets = 0
    stubFetch(() => {
      gets++
      return gets === 1 ? view() : {}
    })
    render(<SessionState><TopicPage /></SessionState>)
    await screen.findByText('gorączka')
    fireEvent.click(within(row('gorączka')).getByRole('button', { name: t.makeCard }))
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.getByText('gorączka')).toBeTruthy()
  })
})
