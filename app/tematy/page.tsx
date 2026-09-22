'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Plus, Search } from '@/components/ui/icons'
import { Switch } from '@/components/ui/Switch'
import { useRestoreScroll, useScreenState } from '@/components/SessionState'
import type { TopicListRow } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/** Every topic, with its card count, what is still generating, and its on/off switch (spec §5.1). */
export default function TopicsPage() {
  const [topics, setTopics] = useScreenState<TopicListRow[]>('tematy:list', () => [])
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useScreenState('tematy:q', () => '')
  useRestoreScroll('tematy', topics.length > 0)

  // A non-2xx or malformed body must never reach setTopics (it would leave
  // `topics` as something other than an array and crash the `.some`/`.map`
  // below), and neither this nor the polling interval that calls it may
  // throw out to an unhandled rejection — so every failure is caught here
  // and turned into an error line, leaving the previous list on screen.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/topics')
      const body: unknown = res.ok ? await res.json() : null
      const list = (body as { topics?: unknown } | null)?.topics
      if (!res.ok || !Array.isArray(list)) throw new Error('failed to load topics')
      setTopics(list as TopicListRow[])
      setError(null)
    } catch {
      setError(t.topicsLoadFailed)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A brand-new topic has no pending captures yet — it is still searching for
  // its first batch — so it must keep the page polling too, or it sits at
  // "nowy temat…" until the page happens to reload.
  const pending = topics.some((x) => x.pendingCount > 0 || x.searching)
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => void load(), 2_000)
    return () => clearInterval(id)
  }, [pending, load])

  async function toggle(topic: TopicListRow) {
    try {
      const res = await fetch(`/api/topics/${topic.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suspendedAt: topic.suspendedAt === null ? Date.now() : null }),
      })
      if (!res.ok) throw new Error('failed to switch topic')
      setError(null)
      await load()
    } catch {
      setError(t.topicSaveFailed)
    }
  }

  // Client-side: the list is already fully loaded, so filtering it needs no
  // request. An unnamed topic has no name to match, so it only shows on an
  // empty query.
  const query = q.trim().toLowerCase()
  const visible = topics.filter((x) => (x.name ?? '').toLowerCase().includes(query))

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-4 bg-background px-4 py-2">
        <div className="relative">
          <Icon icon={Search} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 py-3 pl-10 pr-3"
            placeholder={t.filterTopics}
          />
        </div>
      </div>
      {error && <p className="text-sub text-red-600">{error}</p>}
      <ul className="pb-20">
        {visible.map((x) => (
          <li key={x.id} className="flex flex-col gap-2 border-b py-3">
            <Link href={`/tematy/${x.id}`} className={`break-words text-row ${x.suspendedAt !== null ? 'text-neutral-400' : ''}`}>
              {x.name ?? t.unnamedTopic}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className="tabular-nums">
                {`${x.cardCount} ${t.tabCarded} · ${x.openCount} ${t.tabOpen} · ${x.discardedCount} ${t.tabDiscarded}`}
              </span>
              {x.pendingCount > 0 && <Badge tone="sky">{`+${x.pendingCount} ${t.queued}`}</Badge>}
              <span className="ml-auto">
                <Switch checked={x.suspendedAt === null} label={t.topicOn} onChange={() => void toggle(x)} />
              </span>
            </span>
          </li>
        ))}
      </ul>
      {/* One-handed use: the thumb reaches the bottom of a phone, and this
          list grows downward, so a button above it drifts out of reach as
          topics accumulate. Fixed rather than sticky, for the reason
          app/dodaj/page.tsx's record bar documents at length; `inset-x-0`
          plus the inner `mx-auto max-w-xl` re-centres it, because a fixed
          element ignores the shell's own `max-w-xl`.
          The classes are written out rather than taken from `buttonClass`:
          this is 56 px, and a `h-14` appended after `buttonClass`'s `h-10`
          would leave two height utilities fighting in the stylesheet, where
          the winner is decided by Tailwind's output order, not by the order
          they appear in the attribute. */}
      {/* This band is otherwise an invisible full-width strip with no
          background, sitting above rows further down the list once it
          grows tall enough to reach here. Without `pointer-events-none`
          it swallows taps meant for whatever row is underneath it — the
          row's Link never navigates and its Switch never toggles — so the
          wrapper opts out of hit-testing and only the button opts back in. */}
      <div className="above-tabbar pointer-events-none fixed inset-x-0 z-10">
        <div className="mx-auto flex max-w-xl justify-end px-4 pb-4">
          <Link
            href="/tematy/nowy"
            aria-label={t.newTopic}
            title={t.newTopic}
            className="pointer-events-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg"
          >
            <Icon icon={Plus} size={24} />
          </Link>
        </div>
      </div>
    </div>
  )
}
