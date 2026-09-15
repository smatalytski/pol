// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AddPage from './page'

// Rendering this page never presses the record button, so getUserMedia and
// MediaRecorder are never touched — only the polling effect is exercised
// here. That is deliberate: the hold-to-record gesture itself is already
// covered, isolated from the DOM, in hooks/useHoldToRecord.dom.test.ts.

function captureRow(status: string) {
  return {
    id: 'a',
    status,
    transcript: null,
    error: null,
    cardId: null,
    duplicateOf: null,
    audioMediaId: null,
    createdAt: Date.now(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AddPage polling (spec §9: poll while pending, stop when idle)', () => {
  it('keeps polling while a capture is still in flight, then stops once everything is done', async () => {
    let response = [captureRow('uploaded')]
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ captures: response }) }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<AddPage />)

    // The pending capture keeps the 1s interval alive across several ticks.
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)

    // The pipeline finishes: the next poll observes a terminal status.
    response = [captureRow('generated')]
    await vi.advanceTimersByTimeAsync(1500)

    const settledCount = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)

    // No further polling once nothing is pending — the interval was torn down,
    // not just made to do no-op work every second.
    expect(fetchMock.mock.calls.length).toBe(settledCount)
  })

  it('clears the polling interval on unmount', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ captures: [captureRow('uploaded')] }) }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    const { unmount } = render(<AddPage />)
    await vi.advanceTimersByTimeAsync(2000)
    const countBeforeUnmount = fetchMock.mock.calls.length
    unmount()
    await vi.advanceTimersByTimeAsync(5000)

    expect(fetchMock.mock.calls.length).toBe(countBeforeUnmount)
  })
})
