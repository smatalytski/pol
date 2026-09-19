import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { cards, listens, topics } from '../db/schema'
import { REVIEWABLE, startOfLocalDay } from '../review/queue'
import { getSettings } from '../settings'
import { cachedAudio } from '../audio/card-audio'
import { audioKey, estimateMs, sequenceFor, settingsToSequence, type ListenCard } from '../audio/sequence'
import type { CardRow } from '../cards/service'

export type PlannedCard = {
  id: string
  promptText: string
  topicName: string | null
  estimatedMs: number
  /**
   * The card's CURRENT audio cache key (`audioKey(listenCardOf(card), ...)`,
   * with today's sequence settings). Passed back to `GET
   * /api/listen/cards/:id/audio?k=`: matching it against the audio the route
   * builds right now is what tells the client whether that URL's bytes are
   * still the card's current ones — safe to cache forever — or the card (or
   * a setting) changed since planning, in which case the URL must not be
   * cached at all (see that route's own comment).
   */
  audioKey: string
}

/** The `ListenCard` a row's fields feed into `sequenceFor`/`audioKey`. */
export function listenCardOf(card: CardRow): ListenCard {
  return {
    promptText: card.promptText ?? '',
    promptHint: card.promptHint,
    answerPl: card.answerPl,
    examplePl: card.examplePl,
  }
}

/**
 * A card eligible to be played (spec §3.1): the review queue's `REVIEWABLE`
 * plus `type = 'ru_to_pl'` (in SQL) and a non-blank `prompt_text` (checked in
 * JS, since blankness after trimming isn't expressible as a plain SQL
 * equality/null check without also excluding genuinely-null prompts some
 * other caller might still want to distinguish).
 */
export function eligibleCard(db: Db, id: string): CardRow | null {
  const row = db
    .select()
    .from(cards)
    .where(and(REVIEWABLE, eq(cards.type, 'ru_to_pl'), eq(cards.id, id)))
    .get()
  if (!row) return null
  if (!row.promptText || row.promptText.trim() === '') return null
  return row
}

/**
 * Plans a listening session (spec §4.1): eligible cards, optionally scoped to
 * `topicIds` and minus `excludeIds`, ordered with review cards due by the end
 * of today first (least recently heard first within that group), then the
 * rest — including every never-reviewed card, however recent its creation
 * `due` — (never heard first, then least recently heard), ties broken by
 * `due` then `id` — and taken in that order until the running `estimatedMs`
 * reaches or passes the chosen `minutes`.
 */
export function planSession(
  db: Db,
  input: { minutes: number; topicIds?: string[]; excludeIds?: string[] },
  now: Date,
): PlannedCard[] {
  if (input.topicIds !== undefined && input.topicIds.length === 0) return []

  const exclude = new Set(input.excludeIds ?? [])
  const endOfToday = startOfLocalDay(now) + 86_400_000
  const seqSettings = settingsToSequence(getSettings(db))

  const conditions = [REVIEWABLE, eq(cards.type, 'ru_to_pl')]
  if (input.topicIds !== undefined) conditions.push(inArray(cards.topicId, input.topicIds))

  const rows = db
    .select()
    .from(cards)
    .where(and(...conditions))
    .all()
    .filter((c) => c.promptText !== null && c.promptText.trim() !== '' && !exclude.has(c.id))

  // Last heard per card, as a Map — a plain group-by, read once rather than
  // per card.
  const lastHeard = new Map<string, number>()
  db.select({ cardId: listens.cardId, heardAt: sql<number>`max(${listens.heardAt})` })
    .from(listens)
    .groupBy(listens.cardId)
    .all()
    .forEach((r) => lastHeard.set(r.cardId, r.heardAt))

  const topicNameById = new Map(db.select({ id: topics.id, name: topics.name }).from(topics).all().map((t) => [t.id, t.name]))

  // Group 0 is "due for review by end of today" — a never-reviewed card
  // (state 0) doesn't count, even though its `due` (its creation time, per
  // lib/scheduler's newState) usually looks like "today": that's not a review
  // due date, and letting it in here would crowd out real due reviews. This
  // mirrors the review queue's own due predicate (lib/review/queue.ts).
  const sorted = [...rows].sort((a, b) => {
    const aGroup = a.state !== 0 && a.due <= endOfToday ? 0 : 1
    const bGroup = b.state !== 0 && b.due <= endOfToday ? 0 : 1
    if (aGroup !== bGroup) return aGroup - bGroup

    // Never heard sorts as "least recently heard" — before any real heardAt.
    const aHeard = lastHeard.get(a.id) ?? -Infinity
    const bHeard = lastHeard.get(b.id) ?? -Infinity
    if (aHeard !== bHeard) return aHeard - bHeard

    if (a.due !== b.due) return a.due - b.due
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const budgetMs = input.minutes * 60_000
  const out: PlannedCard[] = []
  let sum = 0
  for (const card of sorted) {
    const listenCard = listenCardOf(card)
    const estimatedMs = cachedAudio(db, listenCard, seqSettings)?.durationMs ?? estimateMs(sequenceFor(listenCard, seqSettings))
    out.push({
      id: card.id,
      promptText: listenCard.promptText,
      topicName: card.topicId ? (topicNameById.get(card.topicId) ?? null) : null,
      estimatedMs,
      audioKey: audioKey(listenCard, seqSettings),
    })
    sum += estimatedMs
    if (sum >= budgetMs) break
  }
  return out
}

/**
 * Records that a card's audio played to its end (spec §3.4). Passive: it
 * never touches `reviews` or a card's FSRS fields, only the listening log.
 * Returns false for an unknown card id rather than inserting anything.
 */
export function markHeard(db: Db, cardId: string, now: Date): boolean {
  const exists = db.select({ id: cards.id }).from(cards).where(eq(cards.id, cardId)).get()
  if (!exists) return false
  db.insert(listens).values({ cardId, heardAt: now.getTime() }).run()
  return true
}
