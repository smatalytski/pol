// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useHoldToRecord, type RecorderFactory } from './useHoldToRecord'

function fakeFactory() {
  let emit: ((bytes: ArrayBuffer, mime: string) => void) | null = null
  const stop = vi.fn(() => emit?.(new Uint8Array([1]).buffer, 'audio/webm'))
  let resolveFactory: (() => void) | null = null
  const factory: RecorderFactory = async (onData) => {
    emit = onData
    if (resolveFactory) await new Promise<void>((r) => { resolveFactory = () => r() })
    return { stop }
  }
  return { factory, stop, hold: () => { resolveFactory = () => {} }, release: () => resolveFactory?.() }
}

describe('useHoldToRecord', () => {
  it('emits the recording when the press is long enough', async () => {
    vi.useFakeTimers()
    const onRecorded = vi.fn()
    const { factory, stop } = fakeFactory()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 300 }))

    await act(async () => { result.current.start() })
    expect(result.current.recording).toBe(true)
    vi.advanceTimersByTime(500)
    await act(async () => { result.current.stop() })

    expect(stop).toHaveBeenCalled()
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(result.current.recording).toBe(false)
    vi.useRealTimers()
  })

  it('DISCARDS a press shorter than minMs as an accidental tap', async () => {
    vi.useFakeTimers()
    const onRecorded = vi.fn()
    const { factory, stop } = fakeFactory()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 300 }))

    await act(async () => { result.current.start() })
    vi.advanceTimersByTime(100)
    await act(async () => { result.current.stop() })

    expect(stop).toHaveBeenCalled() // the recorder is still torn down
    expect(onRecorded).not.toHaveBeenCalled() // but the audio is dropped
    vi.useRealTimers()
  })

  // The implementation compares with `>=`, so exactly 300ms must be KEPT, not
  // discarded — the two tests above only exercise 100ms and 500ms, which
  // would also pass a `> minMs` off-by-one. This pins the boundary itself.
  it('keeps a press of exactly minMs (the boundary is inclusive)', async () => {
    vi.useFakeTimers()
    const onRecorded = vi.fn()
    const { factory, stop } = fakeFactory()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 300 }))

    await act(async () => { result.current.start() })
    vi.advanceTimersByTime(300)
    await act(async () => { result.current.stop() })

    expect(stop).toHaveBeenCalled()
    expect(onRecorded).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('stops a recorder that was still starting up when the finger lifted', async () => {
    const onRecorded = vi.fn()
    const { factory, stop, hold, release } = fakeFactory()
    hold()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 0 }))

    act(() => { result.current.start() })
    act(() => { result.current.stop() }) // finger lifted before getUserMedia resolved
    await act(async () => { release() })

    await waitFor(() => expect(stop).toHaveBeenCalled())
    expect(result.current.recording).toBe(false)
  })

  it('ignores a second start while already recording', async () => {
    const onRecorded = vi.fn()
    const calls = { n: 0 }
    const factory: RecorderFactory = async () => { calls.n++; return { stop: vi.fn() } }
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 0 }))

    await act(async () => { result.current.start() })
    await act(async () => { result.current.start() })
    expect(calls.n).toBe(1)
  })

  it('does nothing on stop when not recording', async () => {
    const { factory } = fakeFactory()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded: vi.fn(), minMs: 0 }))
    await act(async () => { result.current.stop() })
    expect(result.current.recording).toBe(false)
  })

  // A bare `stop()` with no prior `start()` is exercised above, but
  // `recording` starts `false` and stays `false` there regardless of whether
  // `stop()` does anything at all — that assertion can't fail even if `stop`
  // were broken. This one proves it by driving a real start/stop cycle first,
  // then firing a second, unmatched `stop()` and checking with a spy that it
  // does not tear the (already-gone) recorder down a second time.
  it('does not double-tear-down the recorder on a second, unmatched stop', async () => {
    const { factory, stop } = fakeFactory()
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded: vi.fn(), minMs: 0 }))

    await act(async () => { result.current.start() })
    await act(async () => { result.current.stop() })
    expect(stop).toHaveBeenCalledTimes(1)

    await act(async () => { result.current.stop() }) // e.g. a duplicate pointerup/pointercancel pair
    expect(stop).toHaveBeenCalledTimes(1)
    expect(result.current.recording).toBe(false)
  })

  it('resets instead of sticking when the recorder cannot start (mic denied)', async () => {
    const factory: RecorderFactory = async () => {
      throw new Error('NotAllowedError')
    }
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded: vi.fn(), minMs: 0 }))
    await act(async () => { result.current.start() })
    await waitFor(() => expect(result.current.recording).toBe(false))
    // and a later press is still allowed to try again
    await act(async () => { result.current.start() })
    await waitFor(() => expect(result.current.recording).toBe(false))
  })

  // Not from the brief's verbatim test list — added to cover spec §4's
  // "recording the next word while the previous is still processing is
  // expected and must not block". The hook fires `onRecorded` without
  // awaiting it, so a slow (never-settling, here) pipeline callback for the
  // first word must not prevent an immediate second start/stop.
  it('lets a second recording start immediately, without waiting for the previous onRecorded to settle', async () => {
    const { factory } = fakeFactory()
    const onRecorded = vi.fn(() => new Promise<void>(() => {})) // never resolves
    const { result } = renderHook(() => useHoldToRecord({ factory, onRecorded, minMs: 0 }))

    await act(async () => { result.current.start() })
    await act(async () => { result.current.stop() })
    expect(result.current.recording).toBe(false)

    await act(async () => { result.current.start() })
    expect(result.current.recording).toBe(true)
    await act(async () => { result.current.stop() })

    expect(onRecorded).toHaveBeenCalledTimes(2)
  })
})
