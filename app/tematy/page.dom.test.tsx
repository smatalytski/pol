// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { t } from '@/i18n/pl'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const TopicsPage = (await import('./page')).default

const row = (over = {}) => ({
  id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1, cardCount: 23, pendingCount: 4, ...over,
})

function stubFetch(topics: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ topics }) }) as unknown as Promise<Response>
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TopicsPage', () => {
  it('lists each topic with its counts, linking to it', async () => {
    stubFetch([row()])
    render(<TopicsPage />)
    const name = await screen.findByText('U lekarza')
    expect(name.closest('a')?.getAttribute('href')).toBe('/tematy/t1')
    expect(screen.getByText('23')).toBeTruthy()
    expect(screen.getByText(`+4 ${t.queued}`)).toBeTruthy()
  })

  it('links to a new topic', async () => {
    stubFetch([])
    render(<TopicsPage />)
    expect(screen.getByText(t.newTopic).closest('a')?.getAttribute('href')).toBe('/tematy/nowy')
  })

  it('switches a topic off', async () => {
    const calls = stubFetch([row()])
    render(<TopicsPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.topicOn }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/topics/t1')
    expect(JSON.parse(String(patch.init!.body)).suspendedAt).toEqual(expect.any(Number))
  })

  it('shows an unnamed topic as such', async () => {
    stubFetch([row({ name: null })])
    render(<TopicsPage />)
    expect(await screen.findByText(t.unnamedTopic)).toBeTruthy()
  })

  it('shows an error and stays rendered when the list fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }) as unknown as Promise<Response>),
    )
    render(<TopicsPage />)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
    expect(screen.getByText(t.newTopic)).toBeTruthy()
  })

  it('shows an error when a malformed response would otherwise crash the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) as unknown as Promise<Response>),
    )
    render(<TopicsPage />)
    expect(await screen.findByText(t.topicsLoadFailed)).toBeTruthy()
  })

  it('shows an error when switching a topic fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }) as unknown as Promise<Response>
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ topics: [row()] }) }) as unknown as Promise<Response>
      }),
    )
    render(<TopicsPage />)
    fireEvent.click(await screen.findByRole('button', { name: t.topicOn }))
    expect(await screen.findByText(t.topicSaveFailed)).toBeTruthy()
  })
})
