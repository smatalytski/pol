// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('PUTs the edited value on blur and displays exactly what the server echoes back, not what was typed', async () => {
    const calls: Array<{ body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          calls.push({ body: JSON.parse(init.body as string) })
          // Server-side validation is the real guard (spec: it must not be
          // bypassable); this fixture deliberately echoes back a DIFFERENT
          // value (17, not the 20 that was typed) so the assertion below can
          // only pass if the displayed value truly comes from
          // `setSettings(await res.json())` rather than from the input
          // merely retaining whatever the user typed.
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newPerDay: 17, requestRetention: 0.9, audioGapSeconds: 5 }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<SettingsPage />)
    const input = await screen.findByDisplayValue('10')
    fireEvent.change(input, { target: { value: '20' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(calls).toEqual([{ body: { newPerDay: 20 } }])
    expect(await screen.findByDisplayValue('17')).toBeTruthy()
    expect(screen.queryByDisplayValue('20')).toBeNull()
  })

  it('shows an error and reverts to the last confirmed value when the server rejects the input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'bad settings' }) }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<SettingsPage />)
    const input = await screen.findByDisplayValue('10')
    fireEvent.change(input, { target: { value: '999' } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(await screen.findByText(t.settingsSaveFailed)).toBeTruthy()
    expect(await screen.findByDisplayValue('10')).toBeTruthy()
    expect(screen.queryByDisplayValue('999')).toBeNull()
  })

  // Re-review finding on A3: save()'s success branch used to reset BOTH
  // drafts from every successful PUT, regardless of which field's onBlur
  // fired it. Blur field A (an async PUT in flight), then start editing
  // field B before A's response lands — A's stale, pre-edit response must
  // not overwrite B's uncommitted draft.
  it('does not clobber an in-progress edit on one field when the other field\'s PUT resolves later', async () => {
    let resolvePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      resolvePut = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          // Echoes back the server's PRE-edit requestRetention (0.9) — the
          // value from before the user started typing into that field —
          // alongside the newPerDay this PUT actually changed.
          return putGate.then(() => ({
            ok: true,
            json: () => Promise.resolve({ newPerDay: 20, requestRetention: 0.9, audioGapSeconds: 5 }),
          })) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<SettingsPage />)
    const newPerDayInput = await screen.findByDisplayValue('10')
    const retentionInput = screen.getByDisplayValue('0.9')

    // Blur field A (newPerDay) — its PUT is in flight but gated, not resolved yet.
    fireEvent.change(newPerDayInput, { target: { value: '20' } })
    fireEvent.blur(newPerDayInput)

    // While A's PUT is still pending, start editing field B without blurring it.
    fireEvent.change(retentionInput, { target: { value: '0.95' } })

    // Now let A's PUT resolve.
    await act(async () => {
      resolvePut()
      await putGate
    })

    // B's uncommitted edit must survive — not be silently overwritten by A's
    // stale, pre-edit response.
    await waitFor(() => expect(screen.getByDisplayValue('0.95')).toBeTruthy())
    expect(screen.queryByDisplayValue('0.9')).toBeNull()
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
