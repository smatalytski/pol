import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { cards, reviews } from '../db/schema'
import { applyRating, type RatingValue, type SchedulerState } from '../scheduler'
import { getSettings } from '../settings'

function stateOf(row: typeof cards.$inferSelect): SchedulerState {
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReview: row.lastReview,
  }
}

export function recordReview(
  db: Db,
  cardId: string,
  rating: RatingValue,
  durationMs: number | null,
  now: Date,
): SchedulerState {
  const row = db.select().from(cards).where(eq(cards.id, cardId)).get()
  if (!row) throw new Error(`no such card: ${cardId}`)

  const before = stateOf(row)
  const after = applyRating(before, rating, now, getSettings(db).requestRetention)

  db.transaction((tx) => {
    tx.insert(reviews)
      .values({
        cardId,
        rating,
        reviewedAt: now.getTime(),
        durationMs,
        stateBefore: JSON.stringify(before),
        undoneAt: null,
      })
      .run()
    tx.update(cards).set({ ...after, updatedAt: now.getTime() }).where(eq(cards.id, cardId)).run()
  })

  return after
}

export function undoLastReview(db: Db, now: Date): { cardId: string } | null {
  const last = db
    .select()
    .from(reviews)
    .where(isNull(reviews.undoneAt))
    .orderBy(desc(reviews.reviewedAt), desc(reviews.id))
    .limit(1)
    .get()
  if (!last) return null

  const before = JSON.parse(last.stateBefore) as SchedulerState
  db.transaction((tx) => {
    tx.update(cards)
      .set({ ...before, updatedAt: now.getTime() })
      .where(eq(cards.id, last.cardId))
      .run()
    tx.update(reviews)
      .set({ undoneAt: now.getTime() })
      .where(and(eq(reviews.id, last.id), isNull(reviews.undoneAt)))
      .run()
  })
  return { cardId: last.cardId }
}
