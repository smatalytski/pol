// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { MoveToTopic } from './MoveToTopic'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function topicsResponse() {
  return {
    topics: [
      { id: 't1', name: 'U lekarza', isDefault: false, context: '', suspendedAt: null, createdAt: 1 },
      { id: 't2', name: null, isDefault: false, context: '', suspendedAt: null, createdAt: 2 },
      { id: 'default', name: 'Ogólne', isDefault: true, context: '', suspendedAt: null, createdAt: 0 },
    ],
  }
}

describe('MoveToTopic', () => {
  it('shows the current topic name in the button when given, and … otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topicsResponse()) }))
    const { rerender } = render(<MoveToTopic currentTopicId="t1" currentName="Ogólne" onMove={vi.fn()} />)
    expect(screen.getByRole('button', { name: `${t.moveTo}: Ogólne` })).toBeTruthy()

    rerender(<MoveToTopic currentTopicId="t1" onMove={vi.fn()} />)
    expect(screen.getByRole('button', { name: `${t.moveTo}: …` })).toBeTruthy()
  })

  it('lists every topic except the current one and moves on a choice', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topicsResponse()) })
    vi.stubGlobal('fetch', fetchMock)
    const onMove = vi.fn().mockResolvedValue(undefined)

    render(<MoveToTopic currentTopicId="t1" onMove={onMove} />)
    fireEvent.click(screen.getByRole('button', { name: `${t.moveTo}: …` }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/topics'))
    expect(await screen.findByRole('button', { name: 'Ogólne' })).toBeTruthy()
    expect(screen.getByRole('button', { name: t.unnamedTopic })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'U lekarza' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t.unnamedTopic }))
    expect(onMove).toHaveBeenCalledWith('t2')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ogólne' })).toBeNull())
  })

  it('opens a full-width panel and is not itself the positioning context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topicsResponse()) }))
    const { container } = render(<MoveToTopic currentTopicId="t1" onMove={vi.fn()} />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).not.toContain('relative')

    fireEvent.click(screen.getByRole('button', { name: `${t.moveTo}: …` }))
    const panelButton = await screen.findByRole('button', { name: 'Ogólne' })
    const panel = panelButton.parentElement!
    expect(panel.className).toContain('absolute')
    expect(panel.className).toContain('inset-x-0')
    expect(panelButton.className).not.toContain('whitespace-nowrap')
    expect(panelButton.className).toContain('break-words')
  })

  it('paints the open panel above the fixed bottom tab bar (z-20)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topicsResponse()) }))
    render(<MoveToTopic currentTopicId="t1" onMove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: `${t.moveTo}: …` }))
    const panelButton = await screen.findByRole('button', { name: 'Ogólne' })
    const panel = panelButton.parentElement!
    expect(panel.className).toContain('z-30')
  })

  it('shows an icon-only trigger named "temat" when compact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(topicsResponse()) }))
    render(<MoveToTopic currentTopicId="t1" compact onMove={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: t.moveTo })
    expect(trigger.textContent).toBe('')
    fireEvent.click(trigger)
    expect(await screen.findByRole('button', { name: 'Ogólne' })).toBeTruthy()
  })

  it('shows an error when the topics fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }))
    render(<MoveToTopic currentTopicId="t1" onMove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: `${t.moveTo}: …` }))
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
  })
})
