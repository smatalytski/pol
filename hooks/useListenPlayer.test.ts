// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PlannedCard } from '@/lib/listen/service'
import { useListenPlayer } from './useListenPlayer'

class FakeAudio extends EventTarget {
  private _src = ''
  currentTime = 0
  duration = NaN
  paused = true
  ended = false
  get src() {
    return this._src
  }
  set src(v: string) {
    this._src = v
    this.ended = false
  }
  play = vi.fn(async () => {
    this.paused = false
    this.ended = false
  })
  pause = vi.fn(() => {
    this.paused = true
  })
  /** End of stream, as a browser reports it: `pause` first, then `ended`. */
  end(durationSeconds = NaN) {
    this.duration = durationSeconds
    this.paused = true
    this.ended = true
    this.dispatchEvent(new Event('pause'))
    this.dispatchEvent(new Event('ended'))
  }
  /** The system pauses the element on its own (audio focus lost, headphones unplugged). */
  systemPause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  /** The system resumes the element on its own. */
  systemPlay() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }
}

const card = (i: number, estimatedMs = 20_000): PlannedCard => ({
  id: `c${i}`,
  promptText: `prompt ${i}`,
  topicName: i % 2 ? `topic ${i}` : null,
  estimatedMs,
  audioKey: `key/${i}`,
})

type Call = { url: string; body: unknown }

function fakeFetch(opts: {
  cards: PlannedCard[]
  topUps?: PlannedCard[][]
  failing?: Set<string>
}) {
  const calls: Call[] = []
  const topUps = [...(opts.topUps ?? [])]
  let sessions = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })
    if (url === '/api/listen/session') {
      const cards = sessions++ === 0 ? opts.cards : (topUps.shift() ?? [])
      return new Response(JSON.stringify({ cards }), { status: 200 })
    }
    if (url === '/api/listen/heard') return new Response(null, { status: 204 })
    const m = url.match(/^\/api\/listen\/cards\/([^/]+)\/audio\?k=(.+)$/)
    if (m) {
      if (opts.failing?.has(m[1])) {
        return new Response(JSON.stringify({ error: `tts failed for ${m[1]}` }), { status: 502 })
      }
      // Bytes, not a jsdom Blob: Node's Response can't read jsdom's Blob.
      // res.blob() still hands the hook a Blob.
      return new Response(new TextEncoder().encode(m[1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  const audioUrls = () => calls.filter((c) => c.url.includes('/audio')).map((c) => c.url)
  const heardIds = () => calls.filter((c) => c.url === '/api/listen/heard').map((c) => (c.body as { cardId: string }).cardId)
  const sessionBodies = () => calls.filter((c) => c.url === '/api/listen/session').map((c) => c.body)
  return { fetchImpl, calls, audioUrls, heardIds, sessionBodies }
}

const audioUrlOf = (c: PlannedCard) => `/api/listen/cards/${c.id}/audio?k=${encodeURIComponent(c.audioKey)}`

function fakeMediaSession() {
  const handlers = new Map<string, MediaSessionActionHandler | null>()
  const playbackStates: MediaSessionPlaybackState[] = []
  let playbackState: MediaSessionPlaybackState = 'none'
  const ms = {
    metadata: null as MediaMetadata | null,
    get playbackState() {
      return playbackState
    },
    set playbackState(v: MediaSessionPlaybackState) {
      playbackState = v
      playbackStates.push(v)
    },
    setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      handlers.set(action, handler)
    }),
    setPositionState: vi.fn(),
  }
  const fire = (action: MediaSessionAction) => handlers.get(action)?.({ action })
  return { ms: ms as unknown as MediaSession, raw: ms, handlers, fire, playbackStates }
}

let blobN = 0
const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  blobN = 0
  created.length = 0
  revoked.length = 0
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:fake/${++blobN}`
    created.push(u)
    return u
  })
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u)
  })
  vi.stubGlobal(
    'MediaMetadata',
    class {
      title: string
      artist: string
      album: string
      constructor(init: MediaMetadataInit) {
        this.title = init.title ?? ''
        this.artist = init.artist ?? ''
        this.album = init.album ?? ''
      }
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(opts: Parameters<typeof fakeFetch>[0], mediaSession: MediaSession | null = null) {
  const audio = new FakeAudio()
  const f = fakeFetch(opts)
  const hook = renderHook(() =>
    useListenPlayer({ audio: () => audio as unknown as HTMLAudioElement, fetchImpl: f.fetchImpl, mediaSession }),
  )
  return { audio, ...f, hook }
}

function playing(state: ReturnType<typeof useListenPlayer>['state']) {
  if (state.phase !== 'playing' && state.phase !== 'paused') throw new Error(`phase is ${JSON.stringify(state)}`)
  return state
}

describe('useListenPlayer', () => {
  it('start plays card 0 via its ?k= URL and prefetches card 1 before ended', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { audio, audioUrls, sessionBodies, hook } = setup({ cards })

    await act(async () => {
      await hook.result.current.start({ minutes: 10, topicIds: ['t1'] })
    })

    expect(sessionBodies()[0]).toEqual({ minutes: 10, topicIds: ['t1'] })
    const s = playing(hook.result.current.state)
    expect(s.phase).toBe('playing')
    expect(s.index).toBe(0)
    expect(s.cards).toHaveLength(5)
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(audio.src).toBe('blob:fake/1')
    await waitFor(() => expect(audioUrls()).toEqual([audioUrlOf(cards[0]), audioUrlOf(cards[1])]))
  })

  it('ended posts heard for card 0 and moves to card 1', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { audio, heardIds, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })

    await act(async () => {
      audio.end(12)
    })

    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(heardIds()).toEqual(['c0'])
    const s = playing(hook.result.current.state)
    expect(s.heard).toBe(1)
    expect(s.playedMs).toBe(12_000)
    expect(audio.play).toHaveBeenCalledTimes(2)
    // card 0's blob is no longer needed once card 1 plays
    expect(revoked).toContain('blob:fake/1')
  })

  it('uses estimatedMs when the duration is not finite', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i, 7_000))
    const { audio, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await act(async () => {
      audio.end(NaN)
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(playing(hook.result.current.state).playedMs).toBe(7_000)
  })

  it('skip moves on without posting heard', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { audio, heardIds, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })

    await act(async () => {
      hook.result.current.skip()
    })

    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(heardIds()).toEqual([])
    expect(playing(hook.result.current.state).heard).toBe(0)
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('tops up with excludeIds when fewer than 3 cards remain', async () => {
    const cards = [0, 1, 2, 3].map((i) => card(i))
    const { audio, sessionBodies, hook } = setup({ cards, topUps: [[card(10), card(11)]] })
    await act(async () => {
      await hook.result.current.start({ minutes: 20, topicIds: ['t1'] })
    })
    // 3 left after card 0: no top-up yet
    expect(sessionBodies()).toHaveLength(1)

    await act(async () => {
      audio.end(60)
    })

    // 2 left after card 1 → top-up
    await waitFor(() => expect(sessionBodies()).toHaveLength(2))
    const body = sessionBodies()[1] as { minutes: number; topicIds: string[]; excludeIds: string[] }
    expect(body.excludeIds).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(body.topicIds).toEqual(['t1'])
    // 19 minutes left, rounded up to a session length the route accepts
    expect(body.minutes).toBe(20)
    await waitFor(() => expect(playing(hook.result.current.state).cards.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c10', 'c11']))
  })

  it('ends with done when the list runs out', async () => {
    const cards = [card(0)]
    const { audio, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await act(async () => {
      audio.end(5)
    })
    await waitFor(() => expect(hook.result.current.state).toEqual({ phase: 'done', heard: 1 }))
  })

  it('gives done with the right heard count when playedMs reaches the budget', async () => {
    const cards = [0, 1, 2, 3, 4, 5].map((i) => card(i))
    const { audio, heardIds, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })

    await act(async () => {
      audio.end(300)
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    await act(async () => {
      audio.end(300)
    })

    await waitFor(() => expect(hook.result.current.state).toEqual({ phase: 'done', heard: 2 }))
    expect(heardIds()).toEqual(['c0', 'c1'])
    expect(audio.pause).toHaveBeenCalled()
  })

  it('3 failing audio fetches in a row give failed with the last error', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { hook } = setup({ cards, failing: new Set(['c0', 'c1', 'c2']) })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await waitFor(() =>
      expect(hook.result.current.state).toEqual({ phase: 'failed', heard: 0, error: 'tts failed for c2' }),
    )
  })

  it('a failure followed by a success does not fail the session', async () => {
    const cards = [0, 1, 2, 3, 4, 5].map((i) => card(i))
    const { audio, hook } = setup({ cards, failing: new Set(['c0', 'c1', 'c3', 'c4']) })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(2))
    await act(async () => {
      audio.end(5)
    })
    // c3 and c4 fail — two in a row after the success, not three
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(5))
    expect(hook.result.current.state.phase).toBe('playing')
  })

  it('skips a card whose audio fetch throws', async () => {
    const cards = [0, 1, 2, 3].map((i) => card(i))
    const audio = new FakeAudio()
    const f = fakeFetch({ cards })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/listen/cards/c0/')) throw new TypeError('network down')
      return f.fetchImpl(input, init)
    }) as unknown as typeof fetch
    const hook = renderHook(() =>
      useListenPlayer({ audio: () => audio as unknown as HTMLAudioElement, fetchImpl, mediaSession: null }),
    )
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
  })

  it('registers Media Session handlers that drive the player, and metadata follows the card', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { ms, raw, fire } = fakeMediaSession()
    const { audio, heardIds, hook } = setup({ cards }, ms)

    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop']) {
      expect(raw.setActionHandler).toHaveBeenCalledWith(action, expect.any(Function))
    }

    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    expect(raw.metadata).toMatchObject({ title: 'prompt 0', artist: 'Fiszki', album: '' })

    await act(async () => {
      fire('pause')
    })
    expect(audio.pause).toHaveBeenCalled()
    expect(hook.result.current.state.phase).toBe('paused')

    await act(async () => {
      fire('play')
    })
    expect(hook.result.current.state.phase).toBe('playing')
    expect(audio.play).toHaveBeenCalledTimes(2)

    audio.currentTime = 4.2
    await act(async () => {
      fire('previoustrack')
    })
    expect(audio.currentTime).toBe(0)

    await act(async () => {
      fire('nexttrack')
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(heardIds()).toEqual([])
    expect(raw.metadata).toMatchObject({ title: 'prompt 1', artist: 'Fiszki', album: 'topic 1' })

    await act(async () => {
      fire('stop')
    })
    expect(hook.result.current.state).toEqual({ phase: 'done', heard: 0 })
  })

  it('a pause the system makes is mirrored, and the Media Session play resumes it', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { ms, raw, fire } = fakeMediaSession()
    const { audio, hook } = setup({ cards }, ms)
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    expect(raw.playbackState).toBe('playing')

    await act(async () => {
      audio.systemPause()
    })
    expect(hook.result.current.state.phase).toBe('paused')
    expect(raw.playbackState).toBe('paused')

    await act(async () => {
      fire('play')
    })
    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(hook.result.current.state.phase).toBe('playing')
    expect(raw.playbackState).toBe('playing')
  })

  it('resume plays when the element is paused even if no pause event arrived', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { ms, fire } = fakeMediaSession()
    const { audio, hook } = setup({ cards }, ms)
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    audio.paused = true
    await act(async () => {
      fire('play')
    })
    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(hook.result.current.state.phase).toBe('playing')
  })

  it('a play the system makes is mirrored too', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { ms, raw } = fakeMediaSession()
    const { audio, hook } = setup({ cards }, ms)
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await act(async () => {
      audio.systemPause()
    })
    await act(async () => {
      audio.systemPlay()
    })
    expect(hook.result.current.state.phase).toBe('playing')
    expect(raw.playbackState).toBe('playing')
  })

  it('the pause that comes with ended is not read as a user pause', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { ms, raw, playbackStates } = fakeMediaSession()
    const { audio, heardIds, hook } = setup({ cards }, ms)
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    playbackStates.length = 0
    await act(async () => {
      audio.end(10)
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(hook.result.current.state.phase).toBe('playing')
    expect(raw.playbackState).toBe('playing')
    expect(playbackStates).not.toContain('paused')
    expect(heardIds()).toEqual(['c0'])
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('the pause from a skip is not read as a user pause', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { audio, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await act(async () => {
      hook.result.current.skip()
      // a browser reports the pause skip() makes as an event, later
      audio.dispatchEvent(new Event('pause'))
    })
    await waitFor(() => expect(playing(hook.result.current.state).index).toBe(1))
    expect(hook.result.current.state.phase).toBe('playing')
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('clears the Media Session handlers on unmount', async () => {
    const { ms, raw } = fakeMediaSession()
    const { hook } = setup({ cards: [card(0)] }, ms)
    hook.unmount()
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop']) {
      expect(raw.setActionHandler).toHaveBeenCalledWith(action, null)
    }
  })

  it('stop gives done and revokes the blob URLs', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { audio, audioUrls, hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await waitFor(() => expect(audioUrls()).toHaveLength(2))
    await waitFor(() => expect(created).toHaveLength(2))

    await act(async () => {
      hook.result.current.stop()
    })

    expect(hook.result.current.state).toEqual({ phase: 'done', heard: 0 })
    expect(audio.pause).toHaveBeenCalled()
    expect([...revoked].sort()).toEqual([...created].sort())
  })

  it('revokes every blob URL on unmount', async () => {
    const cards = [0, 1, 2, 3, 4].map((i) => card(i))
    const { hook } = setup({ cards })
    await act(async () => {
      await hook.result.current.start({ minutes: 10 })
    })
    await waitFor(() => expect(created).toHaveLength(2))
    hook.unmount()
    expect([...revoked].sort()).toEqual([...created].sort())
  })
})
