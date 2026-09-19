'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useListenPlayer } from '@/hooks/useListenPlayer'
import { t } from '@/i18n/pl'

/** Session lengths the planner accepts (spec §4.1), remembered per browser. */
const LENGTHS = [10, 20, 30, 45] as const
const STORAGE_KEY = 'fiszki:listen:minutes'

type Topic = { id: string; name: string | null; suspendedAt: number | null }
type ListenSettings = {
  audioGapSeconds: number
  audioRepeatAnswer: number
  audioExample: number
  audioHint: number
  audioRepeatExample: number
}

/** The last chosen length, if the browser kept it and it's still one of the offered values. */
function storedMinutes(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY))
    if ((LENGTHS as readonly number[]).includes(n)) return n
  } catch {
    // Storage may be unavailable — fall through to the default.
  }
  return 20
}

function rememberMinutes(n: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(n))
  } catch {
    // Remembering the length is a convenience; without storage it just isn't kept.
  }
}

function summaryLine(s: ListenSettings): string {
  return [
    s.audioGapSeconds > 0 ? `${t.listenSummaryGap} ${s.audioGapSeconds} s` : null,
    s.audioHint === 1 ? t.listenSummaryHint : null,
    s.audioRepeatAnswer === 1 ? t.listenSummaryRepeat : null,
    s.audioExample === 1 ? (s.audioRepeatExample === 1 ? t.listenSummaryExampleTwice : t.listenSummaryExample) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ')
}

export default function ListenPage() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const player = useListenPlayer({ audio: () => audioRef.current! })
  // Starts at the default and picks up the stored choice after mount, in an
  // effect rather than a lazy initializer: /sluchaj is statically
  // prerendered, so a lazy initializer reading localStorage would make the
  // server-rendered markup (always the default) disagree with the first
  // client render (whatever's stored) — a hydration mismatch.
  const [minutes, setMinutes] = useState<number>(20)
  const [topics, setTopics] = useState<Topic[]>([])
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>([])
  const [settings, setSettings] = useState<ListenSettings | null>(null)
  // Set by "Jeszcze raz" — the hook itself has no way back to `idle` from
  // `done`/`failed` (spec §5.2 end state), so the choice screen is shown
  // again locally, with the same length and topics still selected, until the
  // next `start()` puts the hook back in charge of the phase.
  const [backAtIdle, setBackAtIdle] = useState(false)

  useEffect(() => {
    setMinutes(storedMinutes())
  }, [])

  useEffect(() => {
    void fetch('/api/topics')
      .then((r) => r.json())
      .then((d: { topics: Topic[] }) => setTopics(d.topics.filter((topic) => topic.suspendedAt === null)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: ListenSettings) => setSettings(s))
      .catch(() => {})
  }, [])

  function chooseMinutes(n: number) {
    setMinutes(n)
    rememberMinutes(n)
  }

  function chooseAllTopics() {
    setSelectedTopicIds([])
  }

  function toggleTopic(id: string) {
    setSelectedTopicIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function handleStart() {
    setBackAtIdle(false)
    void player.start(selectedTopicIds.length > 0 ? { minutes, topicIds: selectedTopicIds } : { minutes })
  }

  const state = player.state
  let content: ReactNode

  if (backAtIdle || state.phase === 'idle') {
    content = (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-sm text-neutral-500">{t.listenLength}</span>
          <div className="flex gap-2">
            {LENGTHS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={minutes === n}
                onClick={() => chooseMinutes(n)}
                className={`rounded border px-3 py-2 ${minutes === n ? 'bg-black text-white' : ''}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={selectedTopicIds.length === 0}
            onClick={chooseAllTopics}
            className={`rounded border px-3 py-2 ${selectedTopicIds.length === 0 ? 'bg-black text-white' : ''}`}
          >
            {t.listenAllTopics}
          </button>
          {topics.map((topic) => (
            <button
              key={topic.id}
              type="button"
              aria-pressed={selectedTopicIds.includes(topic.id)}
              onClick={() => toggleTopic(topic.id)}
              className={`rounded border px-3 py-2 ${selectedTopicIds.includes(topic.id) ? 'bg-black text-white' : ''}`}
            >
              {topic.name ?? t.unnamedTopic}
            </button>
          ))}
        </div>
        {settings && (
          <Link href="/ustawienia" className="text-sm text-neutral-500 underline">
            {summaryLine(settings)}
          </Link>
        )}
        <button type="button" onClick={handleStart} className="self-start rounded bg-black px-4 py-2 text-white">
          {t.listenStart}
        </button>
      </div>
    )
  } else if (state.phase === 'playing' || state.phase === 'paused') {
    const card = state.cards[state.index]
    const leftMs = minutes * 60_000 - state.playedMs
    const minutesLeft = Math.max(0, Math.ceil(leftMs / 60_000))
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-2xl">{card.promptText}</p>
        <p className="text-sm text-neutral-500">{card.topicName ?? t.unnamedTopic}</p>
        <p className="text-sm text-neutral-500">{`${state.index + 1} / ${state.cards.length}`}</p>
        <p className="text-sm text-neutral-500">{`${t.listenMinutesLeft} ${minutesLeft}`}</p>
        <div className="flex gap-4">
          {state.phase === 'playing' ? (
            <button type="button" aria-label={t.listenPause} onClick={() => player.pause()} className="text-2xl">
              ⏸
            </button>
          ) : (
            <button type="button" aria-label={t.listenResume} onClick={() => player.resume()} className="text-2xl">
              ▶
            </button>
          )}
          <button type="button" aria-label={t.listenSkip} onClick={() => player.skip()} className="text-2xl">
            ⏭
          </button>
          <button type="button" onClick={() => player.stop()} className="rounded border px-4 py-2">
            {t.listenStop}
          </button>
        </div>
      </div>
    )
  } else if (state.phase === 'done') {
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-xl">{`${t.listenDone} ${state.heard} ${t.listenCards}`}</p>
        <button type="button" onClick={() => setBackAtIdle(true)} className="self-start rounded border px-4 py-2">
          {t.listenAgain}
        </button>
      </div>
    )
  } else if (state.phase === 'failed') {
    // Kept as an explicit check rather than a bare final `else`: TS's
    // narrowing-by-elimination doesn't reach through the preceding
    // `phase: 'playing' | 'paused'` branch's OR check into a bare `else`
    // (verified separately), but it does narrow through this explicit check.
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-red-600">{t.listenFailed}</p>
        <p className="text-sm text-neutral-500">{state.error}</p>
        <button type="button" onClick={() => setBackAtIdle(true)} className="self-start rounded border px-4 py-2">
          {t.listenAgain}
        </button>
      </div>
    )
  } else {
    content = null
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Rendered unconditionally from mount, hidden — the hook caches this element on its first effect. */}
      <audio ref={audioRef} className="hidden" />
      {content}
    </div>
  )
}
