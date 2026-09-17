import { NextResponse } from 'next/server'
import { and, asc, gt } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { buildQueue, REVIEWABLE } from '@/lib/review/queue'

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
  // Soft delete (decided 2026-09-16): shares REVIEWABLE with
  // lib/review/queue.ts (rather than re-spelling its conditions) so a future
  // fourth condition can't reach one dialect and not the other.
  const next = db
    .select({ due: cards.due })
    .from(cards)
    .where(and(REVIEWABLE, gt(cards.due, now.getTime())))
    .orderBy(asc(cards.due))
    .limit(1)
    .get()

  return NextResponse.json({ cards: queue, nextDue: next?.due ?? null })
}
