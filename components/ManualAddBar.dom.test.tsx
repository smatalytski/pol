// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n/pl'
import { ManualAddBar } from './ManualAddBar'

class FakeMediaRecorder {
  static isTypeSupported() {
    return true
  }
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null
  onstop: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => {
    this.ondataavailable?.({ data: { size: 1 } })
    this.onstop?.()
  })
  constructor(
    public stream: unknown,
    public opts: unknown,
  ) {}
}

function stubMic() {
  const getUserMedia = vi.fn().mockResolvedValue({} as MediaStream)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  return getUserMedia
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ManualAddBar', () => {
  it('adds the trimmed text and clears the field when onAdd resolves to null', async () => {
    const onAdd = vi.fn().mockResolvedValue(null)
    render(<ManualAddBar onAdd={onAdd} />)
    const field = screen.getByLabelText(t.manualAdd) as HTMLInputElement
    fireEvent.change(field, { target: { value: '  kubek  ' } })
    fireEvent.click(screen.getByRole('button', { name: t.add }))
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('kubek'))
    await waitFor(() => expect(field.value).toBe(''))
  })

  it('shows an error string from onAdd and keeps the text', async () => {
    const onAdd = vi.fn().mockResolvedValue('już jest w tym temacie')
    render(<ManualAddBar onAdd={onAdd} />)
    const field = screen.getByLabelText(t.manualAdd) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'kubek' } })
    fireEvent.click(screen.getByRole('button', { name: t.add }))
    expect(await screen.findByText('już jest w tym temacie')).toBeTruthy()
    expect(field.value).toBe('kubek')
  })

  it('disables dodaj when the text is empty', () => {
    render(<ManualAddBar onAdd={vi.fn()} />)
    expect((screen.getByRole('button', { name: t.add }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('anuluj clears the field and any message', async () => {
    const onAdd = vi.fn().mockResolvedValue('już jest w tym temacie')
    render(<ManualAddBar onAdd={onAdd} />)
    const field = screen.getByLabelText(t.manualAdd) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'kubek' } })
    fireEvent.click(screen.getByRole('button', { name: t.add }))
    await screen.findByText('już jest w tym temacie')
    fireEvent.click(screen.getByRole('button', { name: t.cancel }))
    expect(field.value).toBe('')
    expect(screen.queryByText('już jest w tym temacie')).toBeNull()
  })

  it('holding RU posts lang=ru to the transcribe endpoint and fills the field with the transcript', async () => {
    stubMic()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const posts: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/topics/transcribe' && init?.method === 'POST') {
          posts.push(init.body as FormData)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ transcript: 'привет' }) })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<ManualAddBar onAdd={vi.fn()} />)
    const button = screen.getByRole('button', { name: t.recordRussian })
    await act(async () => {
      fireEvent.pointerDown(button)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320))
    })
    await act(async () => {
      fireEvent.pointerUp(button)
    })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].get('lang')).toBe('ru')
    const field = screen.getByLabelText(t.manualAdd) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('привет'))
  })

  it('shows micDenied when the microphone is refused, but keeps the field usable', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    vi.stubGlobal('fetch', vi.fn())
    render(<ManualAddBar onAdd={vi.fn()} />)
    const button = screen.getByRole('button', { name: t.recordPolish })
    await act(async () => {
      fireEvent.pointerDown(button)
    })
    expect(await screen.findByText(t.micDenied)).toBeTruthy()
    const field = screen.getByLabelText(t.manualAdd) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'still works' } })
    expect(field.value).toBe('still works')
  })

  it('shows transcribeFailed when transcription fails', async () => {
    stubMic()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({ error: 'boom' }) }))
    render(<ManualAddBar onAdd={vi.fn()} />)
    const button = screen.getByRole('button', { name: t.recordPolish })
    await act(async () => {
      fireEvent.pointerDown(button)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320))
    })
    await act(async () => {
      fireEvent.pointerUp(button)
    })
    expect(await screen.findByText(t.transcribeFailed)).toBeTruthy()
  })
})
