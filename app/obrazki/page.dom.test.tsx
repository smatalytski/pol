// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImagesPage from './page'
import { t } from '@/i18n/pl'

function file(name = 'cat.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

describe('ImagesPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uploads the files picked via the hidden input and lists a card per result', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            results: [{ name: 'cat.png', cardId: 'c1', duplicateOf: null, answerPl: 'kot' }],
          }),
      }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ImagesPage />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { files: [file()] } })
    })

    expect(await screen.findByText('kot')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/images', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.body).toBeInstanceOf(FormData)
  })

  it('uploads files dropped onto the dropzone', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({ results: [{ name: 'dog.png', cardId: 'c2', duplicateOf: null, answerPl: 'pies' }] }),
      }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ImagesPage />)
    const dropzone = screen.getByText(t.dropImages)

    await act(async () => {
      fireEvent.drop(dropzone, { dataTransfer: { files: [file('dog.png')] } })
    })

    expect(await screen.findByText('pies')).toBeTruthy()
  })

  it('shows the transcribing label while a batch is in flight, then the results', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ImagesPage />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { files: [file()] } })
    })

    expect(await screen.findByText(t.transcribing)).toBeTruthy()

    await act(async () => {
      resolveFetch({ json: () => Promise.resolve({ results: [{ name: 'cat.png', answerPl: 'kot', cardId: 'c1', duplicateOf: null }] }) })
    })

    await waitFor(() => expect(screen.getByText(t.dropImages)).toBeTruthy())
    expect(screen.getByText('kot')).toBeTruthy()
  })

  it('marks a duplicate result and shows a per-file error without losing the others', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            results: [
              { name: 'cat.png', cardId: 'c1', duplicateOf: 'existing-1', answerPl: 'kot' },
              { name: 'broken.jpg', error: 'not a valid image' },
            ],
          }),
      }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ImagesPage />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [file(), file('broken.jpg')] } })
    })

    expect(await screen.findByText('kot')).toBeTruthy()
    expect(screen.getByText(t.alreadyHave)).toBeTruthy()
    expect(screen.getByText('broken.jpg')).toBeTruthy()
    expect(screen.getByText('not a valid image')).toBeTruthy()
  })
})
