// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'
import type { PlayerState } from '@/hooks/useListenPlayer'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const start = vi.fn()
const pause = vi.fn()
const resume = vi.fn()
const skip = vi.fn()
const stop = vi.fn()
const replay = vi.fn()

let mockState: PlayerState = { phase: 'idle' }

vi.mock('@/hooks/useListenPlayer', () => ({
  useListenPlayer: () => ({
    state: mockState,
    start,
    pause,
    resume,
    skip,
    stop,
    replay,
  }),
}))

const ListenPage = (await import('./page')).default

const STORAGE_KEY = 'fiszki:listen:minutes'
const SETTINGS = { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 }

function stubFetch(topics: unknown[], settings: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/topics') return Promise.resolve({ ok: true, json: () => Promise.resolve({ topics }) }) as unknown as Promise<Response>
      if (url === '/api/settings') return Promise.resolve({ ok: true, json: () => Promise.resolve(settings) }) as unknown as Promise<Response>
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }),
  )
}

const card = (over: Partial<{ id: string; promptText: string; topicName: string | null; estimatedMs: number; audioKey: string }> = {}) => ({
  id: 'c1',
  promptText: 'привет',
  topicName: 'U lekarza',
  estimatedMs: 3000,
  audioKey: 'k1',
  ...over,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  mockState = { phase: 'idle' }
  start.mockClear()
  pause.mockClear()
  resume.mockClear()
  skip.mockClear()
  stop.mockClear()
  replay.mockClear()
})

describe('ListenPage — idle', () => {
  it('renders a hidden audio element unconditionally', () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    const { container } = render(<ListenPage />)
    expect(container.querySelector('audio')).toBeTruthy()
  })

  it('calls start({ minutes: 20 }) by default, with no topicIds', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    fireEvent.click(screen.getByRole('button', { name: t.listenStart }))
    expect(start).toHaveBeenCalledWith({ minutes: 20 })
  })

  it('uses the stored length on mount and sends the chosen length and topic ids once chosen', async () => {
    localStorage.setItem(STORAGE_KEY, '45')
    stubFetch(
      [
        { id: 't1', name: 'U lekarza', suspendedAt: null, isDefault: false },
        { id: 't2', name: 'Zawieszony', suspendedAt: 12345, isDefault: false },
      ],
      { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 },
    )
    render(<ListenPage />)
    // The page is statically prerendered, so the first render always shows
    // the default (20) — the stored choice (45) is applied in an effect
    // after mount, not read in a lazy initializer, or hydration would see
    // the server's 20 and the client's 45 disagree.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '45' }).getAttribute('aria-pressed')).toBe('true')
    })
    fireEvent.click(screen.getByText(t.addTopic))
    // Only the switched-on topic is offered — the suspended one is not.
    const item = await screen.findByText('U lekarza')
    expect(screen.queryByText('Zawieszony')).toBeNull()
    fireEvent.click(item)
    fireEvent.click(screen.getByRole('button', { name: t.listenStart }))
    expect(start).toHaveBeenCalledWith({ minutes: 45, topicIds: ['t1'] })
  })

  it('lists no topics by default and says everything will play', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.listenTopicsAll)).toBeTruthy())
    expect(screen.queryByText('Praca')).toBeNull()
  })

  it('adds a topic through the sheet and plays only that topic', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    // The sheet closed, and the topic is now a chip.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Praca')).toBeTruthy()
    fireEvent.click(screen.getByText(t.listenStart))
    expect(start).toHaveBeenCalledWith({ minutes: 20, topicIds: ['t1'] })
  })

  it('filters the sheet by name', async () => {
    stubFetch(
      [{ id: 't1', name: 'Praca', suspendedAt: null }, { id: 't2', name: 'Dom', suspendedAt: null }],
      SETTINGS,
    )
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.change(await screen.findByPlaceholderText(t.filterTopics), { target: { value: 'dom' } })
    expect(screen.getByText('Dom')).toBeTruthy()
    expect(screen.queryByText('Praca')).toBeNull()
  })

  it('removes a chip and goes back to playing everything', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    fireEvent.click(screen.getByLabelText(`${t.removeTopic}: Praca`))
    expect(screen.getByText(t.listenTopicsAll)).toBeTruthy()
    fireEvent.click(screen.getByText(t.listenStart))
    expect(start).toHaveBeenCalledWith({ minutes: 20 })
  })

  it('says so when every topic is already chosen', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    fireEvent.click(await screen.findByText('Praca'))
    fireEvent.click(screen.getByText(t.addTopic))
    expect(await screen.findByText(t.allTopicsChosen)).toBeTruthy()
  })

  it('focuses the search input when the topic sheet opens', async () => {
    stubFetch([{ id: 't1', name: 'Praca', suspendedAt: null }], SETTINGS)
    render(<ListenPage />)
    await waitFor(() => expect(screen.getByText(t.addTopic)).toBeTruthy())
    fireEvent.click(screen.getByText(t.addTopic))
    const input = await screen.findByPlaceholderText(t.filterTopics)
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('shows a summary line built from settings, linking to /ustawienia', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1, audioHint: 0, audioRepeatExample: 0 })
    render(<ListenPage />)
    const link = await screen.findByText('przerwa 5 s · odpowiedź ×2 · przykład')
    expect(link.closest('a')?.getAttribute('href')).toBe('/ustawienia')
  })

  it('omits disabled parts from the summary line', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 0, audioExample: 0, audioHint: 0, audioRepeatExample: 0 })
    render(<ListenPage />)
    expect(await screen.findByText('przerwa 5 s')).toBeTruthy()
  })

  it('adds "podpowiedź" to the summary line when audioHint is on', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 0, audioExample: 0, audioHint: 1, audioRepeatExample: 0 })
    render(<ListenPage />)
    expect(await screen.findByText('przerwa 5 s · podpowiedź')).toBeTruthy()
  })

  it('shows "przykład ×2" instead of "przykład" when audioExample and audioRepeatExample are both on', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 0, audioExample: 1, audioHint: 0, audioRepeatExample: 1 })
    render(<ListenPage />)
    expect(await screen.findByText('przerwa 5 s · przykład ×2')).toBeTruthy()
  })

  it('shows plain "przykład" when audioExample is on but audioRepeatExample is off', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 0, audioExample: 1, audioHint: 0, audioRepeatExample: 0 })
    render(<ListenPage />)
    expect(await screen.findByText('przerwa 5 s · przykład')).toBeTruthy()
  })

  it('adds "następna N s" to the summary line when audioNextSeconds is set', async () => {
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 0, audioExample: 0, audioHint: 0, audioRepeatExample: 0, audioNextSeconds: 8 })
    render(<ListenPage />)
    expect(await screen.findByText('przerwa 5 s · następna 8 s')).toBeTruthy()
  })
})

describe('ListenPage — playing / paused', () => {
  it('renders the playing card and calls pause/skip/stop', () => {
    mockState = { phase: 'playing', index: 0, cards: [card(), card({ id: 'c2' })], playedMs: 0, heard: 0 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    expect(screen.getByText('привет')).toBeTruthy()
    expect(screen.getByText('U lekarza')).toBeTruthy()
    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.listenPause }))
    expect(pause).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t.listenSkip }))
    expect(skip).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t.listenStop }))
    expect(stop).toHaveBeenCalled()
  })

  it('draws the player controls as icon buttons named for screen readers', () => {
    // …same setup as the pause/skip/stop test, up to the playing phase…
    mockState = { phase: 'playing', index: 0, cards: [card(), card({ id: 'c2' })], playedMs: 0, heard: 0 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    for (const name of [t.listenPause, t.listenSkip]) {
      const b = screen.getByRole('button', { name })
      expect(b.textContent).toBe('')
      expect(b.querySelector('svg')).not.toBeNull()
    }
    expect(screen.getByRole('button', { name: t.listenStop }).textContent).toBe(t.listenStop)
  })

  it('renders the paused card and calls resume', () => {
    mockState = { phase: 'paused', index: 0, cards: [card()], playedMs: 0, heard: 0 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    fireEvent.click(screen.getByRole('button', { name: t.listenResume }))
    expect(resume).toHaveBeenCalled()
  })

  it('shows the minutes left, computed from the chosen length and playedMs', () => {
    // No stored length, so the session was started at the 20-minute default;
    // 5 played minutes should leave 15.
    mockState = { phase: 'playing', index: 0, cards: [card()], playedMs: 5 * 60_000, heard: 0 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    expect(screen.getByText(`${t.listenMinutesLeft} 15`)).toBeTruthy()
  })

  it('falls back to the unnamed-topic label when the card has no topic name', () => {
    mockState = { phase: 'playing', index: 0, cards: [card({ topicName: null })], playedMs: 0, heard: 0 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    expect(screen.getByText(t.unnamedTopic)).toBeTruthy()
  })
})

describe('ListenPage — done / failed', () => {
  it('shows the done text and returns to idle via Jeszcze raz', async () => {
    mockState = { phase: 'done', heard: 7 }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    expect(screen.getByText(`${t.listenDone} 7 ${t.listenCards}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t.listenAgain }))
    expect(await screen.findByRole('button', { name: t.listenStart })).toBeTruthy()
  })

  it('shows the failure text and error, and offers Jeszcze raz', () => {
    mockState = { phase: 'failed', heard: 2, error: 'boom' }
    stubFetch([], { audioGapSeconds: 5, audioRepeatAnswer: 1, audioExample: 1 })
    render(<ListenPage />)
    expect(screen.getByText(t.listenFailed)).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.getByRole('button', { name: t.listenAgain })).toBeTruthy()
  })
})
