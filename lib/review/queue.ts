import { and, asc, eq, isNull, lte, notExists, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { cards, reviews } from '../db/schema'
import { getSettings } from '../settings'
import type { CardType } from '../cards/service'

export type QueueItem = {
  id: string
  type: CardType
  promptText: string | null
  promptHint: string | null
  answerPl: string
  examplePl: string | null
  exampleRu: string | null
  grammarNote: string | null
  isNew: boolean
}

/**
 * Spread `fresh` items through `due` ones instead of front-loading them, so a
 * session that begins with ten unseen cards does not feel like a wall.
 */
export function interleave<A, B>(due: A[], fresh: B[]): (A | B)[] {
  if (fresh.length === 0) return [...due]
  if (due.length === 0) return [...fresh]
  const stride = Math.max(2, Math.floor(due.length / fresh.length))
  const pending = [...fresh]
  const out: (A | B)[] = []
  due.forEach((item, i) => {
    out.push(item)
    if ((i + 1) % stride === 0 && pending.length > 0) out.push(pending.shift()!)
  })
  return [...out, ...pending]
}

export function startOfLocalDay(now: Date): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The single definition of "this review counts as an introduction today":
 * dated today, not undone, and replaying a State.New card. Both
 * `newCardsIntroducedToday` (the count that caps the session) and
 * `buildQueue`'s anti-join (which selects which cards are still eligible to
 * be introduced) consume this exact predicate, so they cannot drift apart.
 */
function introducedTodayPredicate(now: Date) {
  return and(
    sql`${reviews.reviewedAt} >= ${startOfLocalDay(now)}`,
    isNull(reviews.undoneAt),
    sql`json_extract(${reviews.stateBefore}, '$.state') = 0`,
  )
}

/**
 * A card counts as introduced today if its first (non-undone) review today
 * was from State.New. Joined to `cards` and filtered to non-deleted rows
 * (important review finding): without the join, a soft-deleted card's
 * earlier review still consumed one of `newPerDay`'s slots forever, and
 * combined with `findDuplicate` correctly refusing to resurrect a deleted
 * card on re-dictation, a single delete-then-re-dictate silently burned two
 * slots for one surviving card.
 */
export function newCardsIntroducedToday(db: Db, now: Date): number {
  const row = db
    .select({ n: sql<number>`count(distinct ${reviews.cardId})` })
    .from(reviews)
    .innerJoin(cards, and(eq(cards.id, reviews.cardId), isNull(cards.deletedAt)))
    .where(introducedTodayPredicate(now))
    .get()
  return row?.n ?? 0
}

const SELECTION = {
  id: cards.id,
  type: cards.type,
  promptText: cards.promptText,
  promptHint: cards.promptHint,
  answerPl: cards.answerPl,
  examplePl: cards.examplePl,
  exampleRu: cards.exampleRu,
  grammarNote: cards.grammarNote,
}

// Soft delete (decided 2026-09-16, spec §7/§9): a deleted card must never be
// served in a session, which is the whole point of deleting it. `isNull(deletedAt)`
// is a strict tightening of the `cards_due` index predicate (`suspended_at IS
// NULL AND status = 'ready'`), so SQLite can still use that index for this
// query — no index migration needed. Authorized change to this otherwise
// frozen module (task 17 brief).
export const REVIEWABLE = and(isNull(cards.suspendedAt), isNull(cards.deletedAt), eq(cards.status, 'ready'))

export async function buildQueue(db: Db, now: Date): Promise<QueueItem[]> {
  const { newPerDay } = getSettings(db)
  const remaining = Math.max(0, newPerDay - newCardsIntroducedToday(db, now))

  const due = db
    .select(SELECTION)
    .from(cards)
    .where(and(REVIEWABLE, sql`${cards.state} != 0`, lte(cards.due, now.getTime())))
    .orderBy(asc(cards.due))
    .all()

  // `cards.state = 0` alone isn't enough to identify "never introduced": a
  // card can already have a non-undone, New-state review today (the same
  // condition `newCardsIntroducedToday` counts by) while its `state` column
  // still reads 0, e.g. mid-transaction or under a bug elsewhere. Anti-join
  // against that exact predicate (shared with `newCardsIntroducedToday` via
  // `introducedTodayPredicate`) so selection can't drift from counting.
  const notIntroducedToday = notExists(
    db
      .select({ one: sql`1` })
      .from(reviews)
      .where(and(eq(reviews.cardId, cards.id), introducedTodayPredicate(now))),
  )

  const fresh =
    remaining === 0
      ? []
      : db
          .select(SELECTION)
          .from(cards)
          .where(and(REVIEWABLE, eq(cards.state, 0), notIntroducedToday))
          .orderBy(asc(cards.createdAt))
          .limit(remaining)
          .all()

  return interleave(
    due.map((c) => ({ ...c, isNew: false })),
    fresh.map((c) => ({ ...c, isNew: true })),
  )
}
