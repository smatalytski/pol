'use client'
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n/pl'
// Type-only: lib/listen/service pulls in the database, which must never reach
// the client bundle.
import type { PlannedCard } from '@/lib/listen/service'

export type PlayerState =
  | { phase: 'idle' }
  | { phase: 'playing' | 'paused'; index: number; cards: PlannedCard[]; playedMs: number; heard: number }
  | { phase: 'done'; heard: number }
  | { phase: 'failed'; heard: number; error: string }

export type ListenPlayer = {
  state: PlayerState
  start(input: { minutes: number; topicIds?: string[] }): Promise<void>
  pause(): void
  resume(): void
  skip(): void
  replay(): void
  stop(): void
}

type Options = { audio: () => HTMLAudioElement; fetchImpl?: typeof fetch; mediaSession?: MediaSession | null }

/** The lengths `POST /api/listen/session` accepts (spec §4.1). */
const SESSION_LENGTHS = [10, 20, 30, 45] as const
/** Top up when fewer than this many cards remain after the current one. */
const TOP_UP_BELOW = 3
/** Consecutive failures that end the session. */
const MAX_FAILURES = 3
/**
 * How long a card's audio fetch may hang before it's treated as a failure. A
 * request that never resolves would otherwise leave the card "loading"
 * forever — silence with no failure counted, and nothing to skip past.
 */
const AUDIO_FETCH_TIMEOUT_MS = 30_000
const ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack', 'stop'] as const

type Loaded = { ok: true; url: string } | { ok: false; error: string }

type Session = {
  minutes: number
  topicIds?: string[]
  cards: PlannedCard[]
  index: number
  playedMs: number
  heard: number
  failures: number
  paused: boolean
  /** Bumped on every card change, so a slower, older load knows it lost. */
  loadSeq: number
  /** The `loadSeq` whose card last started playing — equal to `loadSeq` once the current card is under way. */
  playingSeq: number
  /** Audio fetches by card id — the current card's and the prefetched next one's. */
  loads: Map<string, Promise<Loaded>>
  /** Blob URLs this session created and has not revoked yet, by card id. */
  urls: Map<string, string>
  topUp: Promise<void> | null
  /** A top-up came back empty: the planner has nothing more to give. */
  exhausted: boolean
}

const audioUrl = (c: PlannedCard) => `/api/listen/cards/${c.id}/audio?k=${encodeURIComponent(c.audioKey)}`

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch {
    // not JSON — fall through
  }
  return `HTTP ${res.status}`
}

/**
 * All playback logic, outside React. Everything the `ended` listener and the
 * Media Session handlers need lives in `session` (not in React state), so they
 * always see current data; `setState` only mirrors it for rendering.
 *
 * Playback advances only on the audio element's own `ended` event, on fetch
 * completions and on user/headset actions — never on a JavaScript timer, which
 * Android throttles once the screen is off.
 */
function createPlayer(env: {
  audio: () => HTMLAudioElement
  fetch: () => typeof fetch
  mediaSession: () => MediaSession | null
  setState: (s: PlayerState) => void
}) {
  let session: Session | null = null
  // Bumped by every start/stop/dispose, so a start whose plan arrives late
  // knows it was superseded.
  let startSeq = 0

  const alive = (s: Session) => session === s

  const postJson = (url: string, body: unknown) =>
    env.fetch()(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  function sync(s: Session) {
    env.setState({
      phase: s.paused ? 'paused' : 'playing',
      index: s.index,
      cards: s.cards,
      playedMs: s.playedMs,
      heard: s.heard,
    })
    const ms = env.mediaSession()
    if (ms) ms.playbackState = s.paused ? 'paused' : 'playing'
  }

  function setMetadata(card: PlannedCard) {
    const ms = env.mediaSession()
    if (!ms || typeof MediaMetadata === 'undefined') return
    ms.metadata = new MediaMetadata({ title: card.promptText, artist: 'Fiszki', album: card.topicName ?? t.unnamedTopic })
  }

  function revoke(s: Session, keep: Set<string>) {
    for (const [id, url] of s.urls) {
      if (keep.has(id)) continue
      URL.revokeObjectURL(url)
      s.urls.delete(id)
      s.loads.delete(id)
    }
  }

  /** Ends the session: silences the audio and frees every blob URL. */
  function end(s: Session) {
    if (!alive(s)) return false
    session = null
    startSeq++
    env.audio().pause()
    revoke(s, new Set())
    s.loads.clear()
    const ms = env.mediaSession()
    if (ms) {
      ms.playbackState = 'none'
      ms.metadata = null
    }
    return true
  }

  function finish(s: Session, final: PlayerState) {
    if (end(s)) env.setState(final)
  }

  function load(s: Session, card: PlannedCard): Promise<Loaded> {
    const existing = s.loads.get(card.id)
    if (existing) return existing
    const p = (async (): Promise<Loaded> => {
      try {
        const res = await env.fetch()(audioUrl(card), { signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS) })
        if (!res.ok) return { ok: false, error: await errorOf(res) }
        const blob = await res.blob()
        if (!alive(s)) return { ok: false, error: 'stopped' }
        const url = URL.createObjectURL(blob)
        s.urls.set(card.id, url)
        return { ok: true, url }
      } catch (e) {
        return { ok: false, error: messageOf(e) }
      }
    })()
    s.loads.set(card.id, p)
    return p
  }

  function prefetchNext(s: Session) {
    const next = s.cards[s.index + 1]
    if (next) void load(s, next)
  }

  function maybeTopUp(s: Session) {
    if (s.topUp || s.exhausted) return
    if (s.cards.length - 1 - s.index >= TOP_UP_BELOW) return
    const leftMs = s.minutes * 60_000 - s.playedMs
    // The planner only accepts the fixed session lengths, so "the minutes
    // left, rounded up" is rounded up to the next one of those. A slightly
    // longer list is harmless: playback stops at the budget anyway.
    const minutes = SESSION_LENGTHS.find((m) => m * 60_000 >= leftMs) ?? SESSION_LENGTHS[SESSION_LENGTHS.length - 1]
    const excludeIds = s.cards.map((c) => c.id)
    s.topUp = (async () => {
      try {
        const res = await postJson('/api/listen/session', {
          minutes,
          ...(s.topicIds ? { topicIds: s.topicIds } : {}),
          excludeIds,
        })
        if (!res.ok) return
        const { cards } = (await res.json()) as { cards: PlannedCard[] }
        if (!alive(s)) return
        const seen = new Set(s.cards.map((c) => c.id))
        const fresh = cards.filter((c) => !seen.has(c.id))
        if (fresh.length === 0) {
          s.exhausted = true
          return
        }
        s.cards = [...s.cards, ...fresh]
        sync(s)
        // The next card may only exist now; prefetch it once the current one is in.
        if (s.urls.has(s.cards[s.index].id)) prefetchNext(s)
      } catch {
        // A failed top-up is retried when the next card starts.
      } finally {
        s.topUp = null
      }
    })()
  }

  async function playAt(s: Session, i: number): Promise<void> {
    if (!alive(s)) return
    const seq = ++s.loadSeq
    if (!s.cards[i]) {
      maybeTopUp(s)
      if (s.topUp) await s.topUp
      if (!alive(s) || seq !== s.loadSeq) return
      if (!s.cards[i]) return finish(s, { phase: 'done', heard: s.heard })
    }
    const card = s.cards[i]
    const audio = env.audio()
    s.index = i
    s.paused = false
    sync(s)
    setMetadata(card)
    maybeTopUp(s)

    const loaded = await load(s, card)
    if (!alive(s) || seq !== s.loadSeq) return
    if (!loaded.ok) return failed(s, i, loaded.error)

    const next = s.cards[i + 1]
    revoke(s, new Set(next ? [card.id, next.id] : [card.id]))
    audio.src = loaded.url
    prefetchNext(s)
    if (s.paused) return // paused while loading: resume() plays it

    try {
      await audio.play()
    } catch (e) {
      if (!alive(s) || seq !== s.loadSeq) return
      // A pause or skip interrupted play() before it started — not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return
      return failed(s, i, messageOf(e))
    }
    if (alive(s) && seq === s.loadSeq) {
      s.failures = 0
      s.playingSeq = seq
    }
  }

  function failed(s: Session, i: number, error: string): Promise<void> | void {
    s.failures++
    if (s.failures >= MAX_FAILURES) return finish(s, { phase: 'failed', heard: s.heard, error })
    return playAt(s, i + 1)
  }

  function onEnded() {
    const s = session
    if (!s) return
    const card = s.cards[s.index]
    if (!s.urls.has(card.id)) return // not this card's file
    void postJson('/api/listen/heard', { cardId: card.id }).catch(() => {
      // Losing one "heard" row only means the card may come up again sooner.
    })
    const duration = env.audio().duration
    s.heard++
    s.playedMs += Number.isFinite(duration) ? Math.round(duration * 1000) : card.estimatedMs
    if (s.playedMs >= s.minutes * 60_000) return finish(s, { phase: 'done', heard: s.heard })
    void playAt(s, s.index + 1)
  }

  async function start(input: { minutes: number; topicIds?: string[] }) {
    if (session) end(session)
    const my = ++startSeq
    let cards: PlannedCard[]
    try {
      const res = await postJson('/api/listen/session', {
        minutes: input.minutes,
        ...(input.topicIds ? { topicIds: input.topicIds } : {}),
      })
      if (!res.ok) throw new Error(await errorOf(res))
      cards = ((await res.json()) as { cards: PlannedCard[] }).cards
    } catch (e) {
      if (my === startSeq) env.setState({ phase: 'failed', heard: 0, error: messageOf(e) })
      return
    }
    if (my !== startSeq) return
    if (cards.length === 0) return env.setState({ phase: 'done', heard: 0 })
    const s: Session = {
      minutes: input.minutes,
      topicIds: input.topicIds,
      cards,
      index: 0,
      playedMs: 0,
      heard: 0,
      failures: 0,
      paused: false,
      loadSeq: 0,
      playingSeq: -1,
      loads: new Map(),
      urls: new Map(),
      topUp: null,
      exhausted: false,
    }
    session = s
    await playAt(s, 0)
  }

  function pause() {
    const s = session
    if (!s || s.paused) return
    s.paused = true
    env.audio().pause()
    sync(s)
  }

  function resume() {
    const s = session
    const audio = env.audio()
    // Decide on the element too: had a system pause slipped past onPause,
    // `s.paused` would still say playing while the element is silent.
    if (!s || (!s.paused && !audio.paused)) return
    s.paused = false
    sync(s)
    // Not loaded yet: the pending load plays it when it lands.
    if (!s.urls.has(s.cards[s.index].id)) return
    const seq = s.loadSeq
    const i = s.index
    audio
      .play()
      .then(() => {
        if (alive(s) && seq === s.loadSeq) s.playingSeq = seq
      })
      .catch((e: unknown) => {
        if (!alive(s) || seq !== s.loadSeq) return
        if (e instanceof DOMException && e.name === 'AbortError') return
        void failed(s, i, messageOf(e))
      })
  }

  /**
   * The element paused. Android Chrome does this on its own — audio focus lost
   * to a call or another app, headphones unplugged — and the player must then
   * read as paused, or the lock-screen/headset Play would do nothing. Ignored:
   * the pause that precedes `ended` at the end of the stream, and any pause
   * while a card change is under way (skip's own pause, a src swap).
   */
  function onPause() {
    const s = session
    if (!s || s.paused) return
    if (env.audio().ended) return
    if (s.playingSeq !== s.loadSeq) return
    s.paused = true
    sync(s)
  }

  /** The element started playing on its own (the system gave audio focus back). */
  function onPlay() {
    const s = session
    if (!s || !s.paused) return
    if (s.playingSeq !== s.loadSeq) return
    s.paused = false
    sync(s)
  }

  function skip() {
    const s = session
    if (!s) return
    env.audio().pause()
    void playAt(s, s.index + 1)
  }

  function replay() {
    if (!session) return
    env.audio().currentTime = 0
  }

  function stop() {
    const s = session
    if (s) finish(s, { phase: 'done', heard: s.heard })
    else startSeq++
  }

  /** Unmount: stop without touching React state. */
  function dispose() {
    startSeq++
    if (session) end(session)
  }

  return { start, pause, resume, skip, replay, stop, onEnded, onPause, onPlay, dispose }
}

export function useListenPlayer(opts: Options): ListenPlayer {
  const [state, setState] = useState<PlayerState>({ phase: 'idle' })
  const optsRef = useRef(opts)
  optsRef.current = opts
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const mediaSession =
    opts.mediaSession !== undefined
      ? opts.mediaSession
      : typeof navigator !== 'undefined'
        ? (navigator.mediaSession ?? null)
        : null
  const mediaSessionRef = useRef(mediaSession)
  mediaSessionRef.current = mediaSession

  const [player] = useState(() =>
    createPlayer({
      audio: () => (audioRef.current ??= optsRef.current.audio()),
      fetch: () => optsRef.current.fetchImpl ?? fetch,
      mediaSession: () => mediaSessionRef.current,
      setState,
    }),
  )

  useEffect(() => {
    const audio = (audioRef.current ??= optsRef.current.audio())
    const onEnded = () => player.onEnded()
    const onPause = () => player.onPause()
    const onPlay = () => player.onPlay()
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('play', onPlay)
    return () => {
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('play', onPlay)
      player.dispose()
    }
  }, [player])

  useEffect(() => {
    if (!mediaSession) return
    const handlers: Record<(typeof ACTIONS)[number], () => void> = {
      play: player.resume,
      pause: player.pause,
      nexttrack: player.skip,
      previoustrack: player.replay,
      stop: player.stop,
    }
    for (const action of ACTIONS) {
      try {
        mediaSession.setActionHandler(action, handlers[action])
      } catch {
        // This browser doesn't support the action.
      }
    }
    return () => {
      for (const action of ACTIONS) {
        try {
          mediaSession.setActionHandler(action, null)
        } catch {
          // as above
        }
      }
    }
  }, [mediaSession, player])

  return {
    state,
    start: player.start,
    pause: player.pause,
    resume: player.resume,
    skip: player.skip,
    replay: player.replay,
    stop: player.stop,
  }
}
