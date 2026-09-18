// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const NewTopicPage = (await import('./page')).default

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  push.mockReset()
})

describe('NewTopicPage', () => {
  it('creates the topic with the context and settings, then opens it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ topicId: 't9' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<NewTopicPage />)
    fireEvent.change(screen.getByLabelText(t.topicContext), { target: { value: 'u mechanika, wymiana sprzęgła' } })
    fireEvent.click(screen.getByRole('button', { name: t.mixPhrases }))
    fireEvent.click(screen.getByRole('button', { name: t.propose }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tematy/t9'))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/topics')
    expect(JSON.parse(init.body)).toEqual({ context: 'u mechanika, wymiana sprzęgła', count: 10, mix: 'frazy' })
  })

  it('cannot propose with an empty context', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<NewTopicPage />)
    expect((screen.getByRole('button', { name: t.propose }) as HTMLButtonElement).disabled).toBe(true)
  })
})
