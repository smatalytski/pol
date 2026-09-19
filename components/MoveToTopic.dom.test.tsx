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

  it('shows an error when the topics fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }))
    render(<MoveToTopic currentTopicId="t1" onMove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: `${t.moveTo}: …` }))
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
  })
})
