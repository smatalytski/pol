import { NextResponse } from 'next/server'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { buildQueue } from '@/lib/review/queue'

export async function GET() {
  const now = new Date()
  const queue = await buildQueue(db, now)

  // Spec §6's "session end" wants "when the next card comes due" once the
  // queue empties. That's the earliest `due` among reviewable cards that
  // aren't due yet — `buildQueue` never caps due cards, so anything already
  // due is necessarily already in `queue`. (This intentionally doesn't
  // account for new cards withheld by the daily cap, whose `due` is already
  // <= now but which resume tomorrow — that's a different kind of "next",
  // and spec doesn't ask for it here.)
  const next = db
    .select({ due: cards.due })
    .from(cards)
    .where(and(isNull(cards.suspendedAt), eq(cards.status, 'ready'), gt(cards.due, now.getTime())))
    .orderBy(asc(cards.due))
    .limit(1)
    .get()

  return NextResponse.json({ cards: queue, nextDue: next?.due ?? null })
}
