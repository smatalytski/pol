import Link from 'next/link'
import type { ReactNode } from 'react'
import type { CardRow } from '@/lib/cards/service'
import { t } from '@/i18n/pl'

/**
 * One row of a card list (app/fiszki/page.tsx, and the topic page's cards —
 * spec 2026-09-18-topic-generation §4.4, "the same rows as /fiszki"): a
 * Polish title, linking to the card's detail screen, plus a status badge
 * where there is something to say. `actions` (spec 2026-09-19-topic-items
 * §4.6 — move/discard/restore row controls) renders in its own element
 * beside the link, never inside it, so a click on a button doesn't also
 * trigger the navigation.
 */
export function CardListItem({
  card,
  topicName,
  topicSuspended,
  generating,
  actions,
}: {
  card: CardRow
  topicName?: string | null
  topicSuspended?: boolean
  generating?: boolean
  actions?: ReactNode
}) {
  return (
    <li className="flex items-center gap-3 border-b">
      <Link href={`/fiszki/${card.id}`} className="flex flex-1 items-baseline justify-between gap-3 py-3">
        <span className="text-lg">{card.answerPl}</span>
        <span className="flex shrink-0 gap-2 text-xs">
          {topicName && <span className="text-neutral-400">{topicName}</span>}
          {card.type === 'pl_to_pl' && <span className="text-sky-700">{t.formsBadge}</span>}
          {card.status === 'needs_input' && <span className="text-amber-600">{t.needsInput}</span>}
          {/* A suspended card is otherwise indistinguishable from an
              active one, leaving no way to see why it never comes up in
              review. Compared against null rather than truthiness so a
              0 timestamp could not render as a bare "0". */}
          {card.suspendedAt !== null && <span className="text-neutral-500">{t.suspended}</span>}
          {/* A card in a switched-off topic is out of review just like one
              suspended individually (spec §3.5), but nothing said so — it
              looked like any other active card. */}
          {topicSuspended && <span className="text-neutral-500">{t.topicOff}</span>}
          {generating && <span className="text-sky-700">{t.generating}</span>}
        </span>
      </Link>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </li>
  )
}
