'use client'
import type { ReactNode } from 'react'
import { CardListItem } from '@/components/CardListItem'
import { MoveToTopic } from '@/components/MoveToTopic'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Plus, Undo2, X } from '@/components/ui/icons'
import type { CardRow } from '@/lib/cards/service'
import type { DiscardedEntry, ItemView, TopicView } from '@/lib/topics/service'
import { t } from '@/i18n/pl'

/**
 * The topic page's three tab bodies (spec 2026-09-19-topic-items §5.2).
 * They own no state: every button hands its write to the page's `act`,
 * which marks the row busy, shows any failure and reloads the view.
 */
export type Act = (key: string, url: string, method: string, body?: unknown) => Promise<void>

type Common = { topicId: string; busy: ReadonlySet<string>; act: Act }

function DiscardButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <Button variant="danger" iconOnly icon={X} label={t.discard} disabled={disabled} onClick={onClick} />
}

/** The move picker, disabled with the rest of its row while a write is in flight. */
function Move({ topicId, disabled, onMove }: { topicId: string; disabled: boolean; onMove: (to: string) => Promise<void> }) {
  return (
    <fieldset disabled={disabled} className="contents">
      <MoveToTopic currentTopicId={topicId} compact onMove={onMove} />
    </fieldset>
  )
}

/** z kartą: pending captures first, then the topic's cards. */
export function CardedTab({
  topicId,
  cards,
  pending,
  topicSuspended,
  busy,
  act,
}: Common & { cards: CardRow[]; pending: TopicView['pending']; topicSuspended: boolean }) {
  return (
    <ul>
      {pending.map((p) => (
        <li key={`pending:${p.id}`} className="flex items-baseline justify-between gap-3 border-b py-3 text-neutral-500">
          <span className="min-w-0 break-words text-row">{p.transcript}</span>
          <Badge tone={p.status === 'generating' ? 'sky' : 'neutral'}>{p.status === 'generating' ? t.generating : t.queued}</Badge>
        </li>
      ))}
      {cards.map((c) => {
        const key = `card:${c.id}`
        const off = busy.has(key)
        return (
          <CardListItem
            key={c.id}
            card={c}
            topicSuspended={topicSuspended}
            actions={
              <>
                <DiscardButton disabled={off} onClick={() => void act(key, `/api/cards/${c.id}`, 'DELETE')} />
                <Move topicId={topicId} disabled={off} onMove={(to) => act(key, `/api/cards/${c.id}`, 'PATCH', { topicId: to })} />
              </>
            }
          />
        )
      })}
    </ul>
  )
}

/** bez karty: the open items, each with `+ karta`, odrzuć and the move picker. */
export function OpenTab({ topicId, items, busy, act }: Common & { items: ItemView[] }) {
  return (
    <ul>
      {items.map((item) => {
        const key = `item:${item.id}`
        const off = busy.has(key)
        const base = `/api/topics/${topicId}/items/${item.id}`
        return (
          <Row key={item.id} relative>
            <span className="break-words">
              <span className="text-row">{item.answerPl}</span>
              {item.glossRu && <span className="text-sub text-neutral-500">{` — ${item.glossRu}`}</span>}
              <span className="ml-2 inline-flex gap-1 align-middle">
                {item.kind && <Badge>{item.kind === 'fraza' ? t.kindPhrase : t.kindWord}</Badge>}
                {item.level === 'sredni' && <Badge tone="amber">{t.levelBadge}</Badge>}
              </span>
            </span>
            <span className="flex flex-wrap justify-end gap-2">
              <Button variant="primary" icon={Plus} label={t.makeCard} disabled={off} onClick={() => void act(key, `${base}/card`, 'POST')} />
              <DiscardButton disabled={off} onClick={() => void act(key, `${base}/discard`, 'POST')} />
              <Move topicId={topicId} disabled={off} onMove={(to) => act(key, base, 'PATCH', { topicId: to })} />
            </span>
          </Row>
        )
      })}
    </ul>
  )
}

/** odrzucone: discarded items and cards (newest first, as the server sends them), each restorable. */
export function DiscardedTab({ topicId, entries, busy, act }: Common & { entries: DiscardedEntry[] }) {
  return (
    <ul>
      {entries.map((e) => {
        const key = e.kind === 'item' ? `item:${e.item.id}` : `card:${e.card.id}`
        const url =
          e.kind === 'item' ? `/api/topics/${topicId}/items/${e.item.id}/restore` : `/api/cards/${e.card.id}/restore`
        return (
          <Row key={key}>
            <span className="break-words">
              <span className="text-row">{e.kind === 'item' ? e.item.answerPl : e.card.answerPl}</span>
              {e.kind === 'card' && (
                <span className="ml-2 align-middle">
                  <Badge tone="sky">{t.cardBadge}</Badge>
                </span>
              )}
            </span>
            <span className="flex justify-end">
              <Button variant="secondary" icon={Undo2} label={t.restore} disabled={busy.has(key)} onClick={() => void act(key, url, 'POST')} />
            </span>
          </Row>
        )
      })}
    </ul>
  )
}

// Two lines: the title (wrapping, full width) above its right-aligned
// controls. `relative` anchors a
// row's MoveToTopic panel to that row rather than the whole page — only rows
// that actually carry one need it.
function Row({ children, relative }: { children: ReactNode; relative?: boolean }) {
  return <li className={`flex flex-col gap-2 border-b py-3 ${relative ? 'relative' : ''}`}>{children}</li>
}
