// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AddPage from './page'
import { clearOutbox, enqueue } from '@/lib/capture/outbox'
import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

function captureRow(id: string, status: string, createdAt = Date.now()): CaptureView {
  return {
    id,
    status,
    transcript: null,
    error: null,
    cardId: null,
    duplicateOf: null,
    audioMediaId: null,
    createdAt,
    cardType: null,
    wordKind: null,
  }
}

// The outbox is a real IndexedDB-backed module singleton (via
// fake-indexeddb), shared across every test in this file — clear it before
// each test so one test's enqueued recording can't leak into the next.
beforeEach(async () => {
  await clearOutbox()
})

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

describe('AddPage polling (spec §9: poll while pending, stop when idle)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps polling while a capture is still in flight, then stops once everything is done', async () => {
    let response = [captureRow('a', 'uploaded')]
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ captures: response }) }) as unknown as Promise<Response>,
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<AddPage />)

    // The pending capture keeps the 1s interval alive across several ticks.
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)

    // The pipeline finishes: the next poll observes a terminal status.
    response = [captureRow('a', 'generated')]
    await vi.advanceTimersByTimeAsync(1500)

    const settledCount = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)

    // No further polling once nothing is pending — the interval was torn down,
    // not just made to do no-op work every second.
    expect(fetchMock.mock.calls.length).toBe(settledCount)
  })

  it('clears the polling interval on unmount', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ captures: [captureRow('a', 'uploaded')] }) }) as unknown as Promise<Response>,
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

// Real (not faked) timers below: these exercise the actual pointer gesture
// and async enqueue/upload chain, which is easier to reason about with real
// microtask/timer interleaving than with fake timers layered on top of
// IndexedDB (fake-indexeddb) internals.
describe('AddPage gesture wiring (fires real pointer events at the button)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ captures: [] }) }) as unknown as Promise<Response>),
    )
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('turns the button into the recording state on pointerdown and back on pointerup', async () => {
    stubMic()
    render(<AddPage />)
    const button = screen.getByRole('button', { name: t.holdToRecord })
    expect(button.className).toContain('bg-black')

    // Let getUserMedia (and the rest of the factory's setup) resolve before
    // releasing, so this test isolates "does pointerup map to stop()" rather
    // than re-proving the already-covered "release before the recorder
    // finished starting up" edge case from the hook's own test suite.
    await act(async () => {
      fireEvent.pointerDown(button)
    })
    expect(button.className).toContain('bg-red-600')

    await act(async () => {
      fireEvent.pointerUp(button)
    })
    expect(button.className).toContain('bg-black')
  })

  it('cleans up the same way when the gesture is cancelled instead of released', async () => {
    stubMic()
    render(<AddPage />)
    const button = screen.getByRole('button', { name: t.holdToRecord })

    await act(async () => {
      fireEvent.pointerDown(button)
    })
    expect(button.className).toContain('bg-red-600')

    await act(async () => {
      fireEvent.pointerCancel(button)
    })
    expect(button.className).toContain('bg-black')

    // Not stuck: a fresh press right after still works.
    await act(async () => {
      fireEvent.pointerDown(button)
    })
    expect(button.className).toContain('bg-red-600')

    await act(async () => {
      fireEvent.pointerUp(button)
    })
    expect(button.className).toContain('bg-black')
  })
})

describe('AddPage mic-denied screen', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ captures: [] }) }) as unknown as Promise<Response>),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows the explanatory screen instead of the capture UI when the microphone is denied', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })

    render(<AddPage />)
    const button = screen.getByRole('button', { name: t.holdToRecord })

    await act(async () => {
      fireEvent.pointerDown(button)
    })

    expect(await screen.findByText(t.micDenied)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.holdToRecord })).toBeNull()
  })
})

describe('AddPage outbox chips (spec §11: an upload stuck retrying still gets its own chip)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows a recording with no server row yet as an uploading chip, with no replay or retry controls', async () => {
    await enqueue({ id: 'local-1', bytes: new Uint8Array([1]).buffer, mime: 'audio/webm', createdAt: Date.now() })

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('/api/captures?since=')) {
          return Promise.resolve({ json: () => Promise.resolve({ captures: [] }) }) as unknown as Promise<Response>
        }
        if (url === '/api/captures' && init?.method === 'POST') {
          // The upload keeps failing (spec §11: retries with backoff): the
          // item is never deleted from the outbox, so its chip should keep
          // showing "uploading" rather than vanish.
          return Promise.resolve({ ok: false, status: 503 }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const { unmount } = render(<AddPage />)

    expect(await screen.findByText(t.uploading)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.retry })).toBeNull()
    expect(screen.queryByLabelText(t.play)).toBeNull()

    // The upload never succeeds in this test, so `hasPending` stays true and
    // the real 1s interval keeps retrying — unmount explicitly, before the
    // afterEach hook removes the fetch mock, so a stray retry doesn't hit the
    // real global fetch after the mock is gone.
    unmount()
  })

  // Drives the real gesture (not a direct `enqueue`) so the optimistic
  // "uploading" chip that `onRecorded` shows immediately on release is the
  // same one that must be reconciled away once the upload lands — a direct
  // `enqueue` bypasses that optimistic update entirely and could pass this
  // check even if `drain` never refreshed `outboxItems` after a fast,
  // single-attempt success.
  it('replaces the uploading chip with the server chip once the upload lands, without duplicating it permanently', async () => {
    stubMic()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    let captures: CaptureView[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('/api/captures?since=')) {
          return Promise.resolve({ json: () => Promise.resolve({ captures }) }) as unknown as Promise<Response>
        }
        if (url === '/api/captures' && init?.method === 'POST') {
          // Mirrors the real route: the server row exists (createCapture ran)
          // by the time the POST resolves, before the outbox item is deleted.
          captures = [captureRow('server-2', 'uploaded')]
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ captureId: 'server-2' }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const { unmount } = render(<AddPage />)
    const button = screen.getByRole('button', { name: t.holdToRecord })

    await act(async () => {
      fireEvent.pointerDown(button)
    })
    // AddPage doesn't override the hook's default 300ms minMs, so the press
    // needs to actually last that long in real time or the release is
    // discarded as an accidental tap and onRecorded never fires.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320))
    })
    await act(async () => {
      fireEvent.pointerUp(button)
    })

    // Right after release, the word is visible as its own chip (uploading,
    // since the upload hasn't landed on the server yet from the client's
    // point of view).
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(1))

    // Once the upload lands, exactly one chip remains for this word — no
    // leftover "uploading" phantom sitting alongside the new server chip.
    await waitFor(() => expect(screen.queryByText(t.uploading)).toBeNull())
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))

    // Status stays 'uploaded' (non-terminal) in this fixture, so `hasPending`
    // never goes false and the real interval keeps running — unmount before
    // the fetch mock is torn down, for the same reason as the test above.
    unmount()
  })

  // The two tests above only check *eventual* state via `waitFor`, and the
  // mocked `/api/captures?since=` GET resolves as a near-instant microtask —
  // so they can't see a window that opens only while a real network request
  // is in flight. This test holds that GET open on a deferred promise it
  // controls, so it can assert on the render that exists *during* the gap
  // between "the upload landed" and "the server row was fetched" — the
  // window `drain()` must not open at all.
  it('never has the word absent from every list while the server row is being fetched', async () => {
    stubMic()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    let capturesFixture: CaptureView[] = []
    let postCalls = 0
    // Every `/api/captures?since=` call (there can be more than one — the
    // polling effect's own `fetchCaptures()` and `drain()`'s post-upload
    // re-fetch can both fire around the same time; that redundancy is
    // known and accepted, not what this test is about) is held open on a
    // deferred promise until explicitly released below, so the assertion
    // can be made about the render that exists while ALL of them are still
    // pending — none has had a chance to update any state yet.
    const capturesGetResolvers: Array<(res: unknown) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('/api/captures?since=')) {
          return new Promise((resolve) => {
            capturesGetResolvers.push(resolve)
          })
        }
        if (url === '/api/captures' && init?.method === 'POST') {
          postCalls++
          capturesFixture = [captureRow('server-3', 'uploaded')]
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ captureId: 'server-3' }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const { unmount } = render(<AddPage />)
    const button = screen.getByRole('button', { name: t.holdToRecord })

    await act(async () => {
      fireEvent.pointerDown(button)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320))
    })
    await act(async () => {
      fireEvent.pointerUp(button)
    })

    // Wait until the upload has resolved — `drain()`'s `sent.length > 0`
    // branch has necessarily started (and issued its captures re-fetch) by
    // this point — but release none of the pending GETs yet.
    await waitFor(() => expect(postCalls).toBe(1))

    // The upload has landed server-side, but every captures re-fetch is
    // still pending, so nothing has reconciled the local outbox chip away
    // yet. The word's chip must still be present — it must not have
    // vanished from every list while this is in flight.
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(t.uploading)).toBeTruthy()

    // Release every deferred GET: the server chip lands and the outbox chip
    // is reconciled away, converging to exactly one chip for this word.
    await act(async () => {
      for (const resolve of capturesGetResolvers) {
        resolve({ json: () => Promise.resolve({ captures: capturesFixture }) })
      }
    })
    await waitFor(() => expect(screen.queryByText(t.uploading)).toBeNull())
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))

    unmount()
  })
})

describe('AddPage chip deletion (spec §4: "swipe to delete", wired up once Task 17 added the routes)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function swipeLeft(el: Element) {
    fireEvent.pointerDown(el, { clientX: 200 })
    fireEvent.pointerUp(el, { clientX: 80 })
  }

  it('soft-deletes the card when swiping a chip whose capture already has one', async () => {
    const deleteCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('/api/captures?since=')) {
          return Promise.resolve({
            json: () => Promise.resolve({ captures: [{ ...captureRow('c1', 'generated'), cardId: 'card-1' }] }),
          }) as unknown as Promise<Response>
        }
        if (init?.method === 'DELETE') {
          deleteCalls.push(url)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<AddPage />)
    const li = await screen.findByRole('listitem')
    swipeLeft(li)
    await waitFor(() => expect(deleteCalls).toEqual(['/api/cards/card-1']))
  })

  it('removes the capture (not a card) when swiping a chip whose capture has no card yet', async () => {
    const deleteCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.startsWith('/api/captures?since=')) {
          return Promise.resolve({
            json: () => Promise.resolve({ captures: [captureRow('c2', 'failed')] }),
          }) as unknown as Promise<Response>
        }
        if (init?.method === 'DELETE') {
          deleteCalls.push(url)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }) as unknown as Promise<Response>
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    render(<AddPage />)
    const li = await screen.findByRole('listitem')
    swipeLeft(li)
    await waitFor(() => expect(deleteCalls).toEqual(['/api/captures/c2']))
  })
})

describe('AddPage layout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // One-handed use: on a phone the thumb reaches the bottom of the screen, not
  // the top, and the chip waterfall grows downward — so a button above the
  // list drifts further out of reach the longer a session runs.
  it('puts the record button after the capture list, at the bottom of the screen', async () => {
    stubMic()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ captures: [captureRow('c1', 'generated')] }),
          }) as unknown as Promise<Response>,
      ),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.holdToRecord)
    const list = screen.getByRole('list')
    expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  // DOM order was not enough. `sticky bottom-0` shipped first, and sticky only
  // pins an element once its container overflows the viewport — nothing in the
  // shell constrains height, so with a few chips the page is shorter than the
  // screen and the button rendered right under the chips, near the top, which
  // is what the user saw. jsdom has no layout engine, so these pin the
  // mechanism rather than the appearance: the bar is positioned against the
  // viewport, and the list reserves room so the last chip cannot hide beneath
  // it.
  it('anchors the button to the viewport, not to the end of the list', async () => {
    stubMic()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ captures: [captureRow('c1', 'generated')] }),
          }) as unknown as Promise<Response>,
      ),
    )
    render(<AddPage />)
    const bar = (await screen.findByText(t.holdToRecord)).closest('div')!
    expect(bar.className).toContain('fixed')
    expect(bar.className).toContain('bottom-0')
    expect(bar.className).not.toContain('sticky')
  })

  it('reserves room under the list so the last chip is not covered by the button', async () => {
    stubMic()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ captures: [captureRow('c1', 'generated')] }),
          }) as unknown as Promise<Response>,
      ),
    )
    render(<AddPage />)
    await screen.findByText(t.holdToRecord)
    expect(screen.getByRole('list').className).toMatch(/\bpb-/)
  })
})

describe('AddPage re-recognition', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('asks the server to re-recognise a capture in Russian, then refreshes', async () => {
    stubMic()
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              captures: [{ ...captureRow('cap-1', 'generated'), audioMediaId: 'm1', transcript: 'sklep' }],
              cardId: 'c1',
              duplicateOf: null,
              error: null,
            }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.asRussian)
    await act(async () => {
      fireEvent.click(button)
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/captures/cap-1/jezyk')
    expect(post?.body).toEqual({ lang: 'ru' })
    // The refreshed transcript has to arrive without the user reloading.
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/captures?since=')).length).toBeGreaterThan(1)
  })

  it('asks the server to make a capture card forms-only, then refreshes', async () => {
    stubMic()
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              captures: [
                {
                  ...captureRow('cap-1', 'generated'),
                  audioMediaId: 'm1',
                  transcript: 'kot',
                  cardId: 'card-1',
                  cardType: 'ru_to_pl',
                  wordKind: 'rzeczownik',
                },
              ],
              card: null,
              duplicateOf: null,
            }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe('/api/cards/card-1/typ')
    expect(post?.body).toEqual({ type: 'pl_to_pl' })
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/captures?since=')).length).toBeGreaterThan(1)
  })

  // A 400 — e.g. a noun whose forms_json turned out empty — must not look like
  // a dead button: the refresh still happens (the chip may have changed for
  // other reasons), but the failure has to say so.
  it('shows a failure notice when the type switch is rejected', async () => {
    stubMic()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'no forms' }) }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              captures: [
                {
                  ...captureRow('cap-1', 'generated'),
                  audioMediaId: 'm1',
                  transcript: 'kot',
                  cardId: 'card-1',
                  cardType: 'ru_to_pl',
                  wordKind: 'rzeczownik',
                },
              ],
            }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeFailed)).toBeTruthy()
  })

  // A 200 carrying `duplicateOf` means a pl_to_pl card for this word already
  // exists, so this capture's card was NOT switched — that also has to be
  // said, not left looking like a silent success.
  it('shows a duplicate notice when a pl_to_pl card for this word already exists', async () => {
    stubMic()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ card: null, duplicateOf: 'other' }),
          }) as unknown as Promise<Response>
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              captures: [
                {
                  ...captureRow('cap-1', 'generated'),
                  audioMediaId: 'm1',
                  transcript: 'kot',
                  cardId: 'card-1',
                  cardType: 'ru_to_pl',
                  wordKind: 'rzeczownik',
                },
              ],
            }),
        }) as unknown as Promise<Response>
      }),
    )
    render(<AddPage />)
    const button = await screen.findByText(t.typePlPl)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(await screen.findByText(t.typeDuplicate)).toBeTruthy()
  })
})
