// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './page'
import { t } from '@/i18n/pl'

describe('SettingsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads and displays the current settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ newPerDay: 12, requestRetention: 0.87, audioGapSeconds: 5 }),
        }) as unknown as Promise<Response>,
      ),
    )
    render(<SettingsPage />)
    expect(await screen.findByDisplayValue('12')).toBeTruthy()
    expect(screen.getByDisplayValue('0.87')).toBeTruthy()
  })

  it('PUTs the edited value on blur and refreshes from the (validated) server response', async () => {
    const calls: Array<{ body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          calls.push({ body: JSON.parse(init.body as string) })
          // Server-side validation is the real guard (spec: it must not be
          // bypassable); this fixture just reflects a legitimate value back.
          return Promise.resolve({ json: () => Promise.resolve({ newPerDay: 20, requestRetention: 0.9, audioGapSeconds: 5 }) }) as unknown as Promise<Response>
        }
        return Promise.resolve({ json: () => Promise.resolve({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 }) }) as unknown as Promise<Response>
      }),
    )
    render(<SettingsPage />)
    const input = await screen.findByDisplayValue('10')
    fireEvent.change(input, { target: { value: '20' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(calls).toEqual([{ body: { newPerDay: 20 } }])
    expect(await screen.findByDisplayValue('20')).toBeTruthy()
  })

  it('renders nothing before settings have loaded', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<SettingsPage />)
    expect(container.firstChild).toBeNull()
  })

  it('labels both inputs with their Polish names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 }) }) as unknown as Promise<Response>),
    )
    render(<SettingsPage />)
    await screen.findByDisplayValue('10')
    expect(screen.getByText(t.newPerDay)).toBeTruthy()
    expect(screen.getByText(t.targetRetention)).toBeTruthy()
  })
})
