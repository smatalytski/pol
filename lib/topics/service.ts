import { and, count, desc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client'
import { captures, cards, generationJobs, suggestions, topics } from '../db/schema'
import { answerKey } from '../cards/answer-key'
import type { CardRow } from '../cards/service'
import type { Suggester } from '../generate'
import { enqueueJob, type JobRow } from '../queue/jobs'
import { MIXES, mixTarget, pickRound, requestSize, type RoundParams } from './rounds'
import type { SuggestionKind } from './rounds'

/**
 * Topics and their rounds (spec 2026-09-18-topic-generation). Everything here
 * that touches the database; the pure rules are in ./rounds.
 */

export type TopicRow = typeof topics.$inferSelect
export type SuggestionRow = typeof suggestions.$inferSelect

const RoundJob = z.object({
  round: z.number().int().positive(),
  count: z.number().int().positive(),
  mix: z.enum(MIXES),
})

export function parseRoundJob(paramsJson: string | null): z.infer<typeof RoundJob> {
  return RoundJob.parse(JSON.parse(paramsJson ?? 'null'))
}

/** The topic's `suggest` job that is waiting or running, if any: at most one at a time (§6.1). */
export function activeSuggestJob(db: Db, topicId: string): JobRow | undefined {
  return db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, 'suggest'),
        eq(generationJobs.topicId, topicId),
        inArray(generationJobs.status, ['queued', 'running']),
      ),
    )
    .get()
}

/** The highest round that has items; 0 before the first one arrives. */
export function latestRound(db: Db, topicId: string): number {
  const row = db.select({ n: max(suggestions.round) }).from(suggestions).where(eq(suggestions.topicId, topicId)).get()
  return row?.n ?? 0
}

/**
 * Queues the next round, numbered after the highest that exists. A failed
 * round left no items, so retrying it gets the same number. Returns null,
 * queueing nothing, while the topic already has a round in flight.
 */
export function enqueueSuggest(db: Db, topicId: string, params: RoundParams, now: Date): string | null {
  if (activeSuggestJob(db, topicId)) return null
  const round = latestRound(db, topicId) + 1
  return enqueueJob(db, { kind: 'suggest', topicId, paramsJson: JSON.stringify({ round, ...params }) }, now)
}

/** answer keys of live ru_to_pl cards: a round never offers a word already in the deck. */
function deckKeys(db: Db): string[] {
  return db
    .select({ key: cards.answerKey })
    .from(cards)
    .where(and(eq(cards.type, 'ru_to_pl'), isNull(cards.deletedAt)))
    .all()
    .map((r) => r.key)
}

function roundExists(db: Db, topicId: string, round: number): boolean {
  return !!db
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(and(eq(suggestions.topicId, topicId), eq(suggestions.round, round)))
    .get()
}

/**
 * Job `suggest`: asks for a round and stores what survives dedup as
 * `proposed` (§5). The deck is filtered here rather than sent in the prompt:
 * it grows without bound, the topic's history does not. A failure is thrown
 * for the queue to classify; there is nothing to fall back to.
 */
export async function runSuggest(deps: { db: Db; suggester: Suggester }, job: JobRow, now: Date): Promise<void> {
  const { db } = deps
  const params = parseRoundJob(job.paramsJson)
  const topic = job.topicId ? db.select().from(topics).where(eq(topics.id, job.topicId)).get() : undefined
  if (!topic) return
  // Already stored by a run that died before the job was marked done.
  if (roundExists(db, topic.id, params.round)) return

  const history = db
    .select({ answerPl: suggestions.answerPl })
    .from(suggestions)
    .where(eq(suggestions.topicId, topic.id))
    .orderBy(suggestions.createdAt, sql`rowid`)
    .all()
    .map((r) => r.answerPl)
  const n = requestSize(params.count)
  const result = await deps.suggester.suggest({ context: topic.context, count: n, ...mixTarget(n, params.mix), exclude: history })

  const taken = new Set([...history.map(answerKey), ...deckKeys(db)])
  const picked = pickRound(result.items, taken, params.count)
  const name = result.topic_name.trim()
  db.transaction((tx) => {
    if (roundExists(tx as unknown as Db, topic.id, params.round)) return
    if (name) tx.update(topics).set({ name }).where(and(eq(topics.id, topic.id), isNull(topics.name))).run()
    for (const item of picked) {
      tx.insert(suggestions)
        .values({
          id: randomUUID(),
          topicId: topic.id,
          round: params.round,
          answerPl: item.answer_pl,
          glossRu: item.gloss_ru,
          kind: item.kind,
          status: 'proposed',
          captureId: null,
          createdAt: now.getTime(),
        })
        .run()
    }
  })
}

/**
 * Accepts a round in one transaction (§6.3): every `proposed` item of it is
 * rejected if listed, otherwise accepted — becoming an audio-less capture
 * with an ordinary `new` job, so card generation, dedup and the pending list
 * are the dictation ones. Only `proposed` items change, so a repeated request
 * is harmless. `next` also queues the following round, unless one is already
 * in flight.
 */
export function acceptRound(
  db: Db,
  topicId: string,
  round: number,
  rejected: readonly string[],
  next: RoundParams | null,
  now: Date,
): { accepted: number; nextJobId: string | null } | null {
  return db.transaction((tx) => {
    const t = tx as unknown as Db
    if (!t.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get()) return null
    const reject = new Set(rejected)
    const proposed = t
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.topicId, topicId), eq(suggestions.round, round), eq(suggestions.status, 'proposed')))
      .orderBy(suggestions.createdAt, sql`rowid`)
      .all()
    let accepted = 0
    for (const s of proposed) {
      if (reject.has(s.id)) {
        t.update(suggestions).set({ status: 'rejected' }).where(eq(suggestions.id, s.id)).run()
        continue
      }
      const captureId = randomUUID()
      t.insert(captures)
        .values({
          id: captureId,
          audioMediaId: null,
          transcript: s.answerPl,
          status: 'queued',
          error: null,
          generationJson: null,
          cardId: null,
          createdAt: now.getTime(),
          transcribedAt: null,
          duplicateOf: null,
          topicId,
          glossRu: s.glossRu,
        })
        .run()
      enqueueJob(t, { kind: 'new', captureId }, now)
      t.update(suggestions).set({ status: 'accepted', captureId }).where(eq(suggestions.id, s.id)).run()
      accepted++
    }
    // A stale page can post an old `:round` after the topic has already moved
    // on to a newer one; queueing round+1 in that case would jump past the
    // newer round's still-undecided items and strand them. Only the current
    // round may ask for the next one.
    const current = round >= latestRound(t, topicId)
    return { accepted, nextJobId: next && current ? enqueueSuggest(t, topicId, next, now) : null }
  })
}

export function createTopic(db: Db, input: { context: string } & RoundParams, now: Date): string {
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(topics).values({ id, name: null, context: input.context.trim(), suspendedAt: null, createdAt: now.getTime() }).run()
    enqueueSuggest(tx as unknown as Db, id, { count: input.count, mix: input.mix }, now)
  })
  return id
}

const PENDING = ['queued', 'generating'] as const

export type TopicListRow = TopicRow & { cardCount: number; pendingCount: number; searching: boolean }

export function listTopics(db: Db): TopicListRow[] {
  const cardCounts = new Map(
    db
      .select({ topicId: cards.topicId, n: count() })
      .from(cards)
      .where(and(isNotNull(cards.topicId), isNull(cards.deletedAt)))
      .groupBy(cards.topicId)
      .all()
      .map((r) => [r.topicId!, r.n]),
  )
  const pendingCounts = new Map(
    db
      .select({ topicId: captures.topicId, n: count() })
      .from(captures)
      .where(and(isNotNull(captures.topicId), inArray(captures.status, PENDING)))
      .groupBy(captures.topicId)
      .all()
      .map((r) => [r.topicId!, r.n]),
  )
  // A topic still searching for its first (or next) round: /tematy polls
  // for it too, so a brand-new topic does not sit at "nowy temat…" until
  // the page happens to reload.
  const searchingIds = new Set(
    db
      .select({ topicId: generationJobs.topicId })
      .from(generationJobs)
      .where(and(eq(generationJobs.kind, 'suggest'), isNotNull(generationJobs.topicId), inArray(generationJobs.status, ['queued', 'running'])))
      .all()
      .map((r) => r.topicId!),
  )
  return db
    .select()
    .from(topics)
    .orderBy(desc(topics.createdAt))
    .all()
    .map((t) => ({
      ...t,
      cardCount: cardCounts.get(t.id) ?? 0,
      pendingCount: pendingCounts.get(t.id) ?? 0,
      searching: searchingIds.has(t.id),
    }))
}

/** Names of named topics, for showing beside cards. */
export function topicNames(db: Db): Record<string, string> {
  return Object.fromEntries(
    db.select({ id: topics.id, name: topics.name }).from(topics).where(isNotNull(topics.name)).all().map((t) => [t.id, t.name!]),
  )
}

/** Ids of switched-off topics, so a card whose topic is off (not the card itself) can be badged too (§3.5). */
export function suspendedTopicIds(db: Db): string[] {
  return db
    .select({ id: topics.id })
    .from(topics)
    .where(isNotNull(topics.suspendedAt))
    .all()
    .map((t) => t.id)
}

function latestSuggestJob(db: Db, topicId: string): JobRow | undefined {
  return db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, 'suggest'), eq(generationJobs.topicId, topicId)))
    .orderBy(desc(generationJobs.createdAt), desc(sql`rowid`))
    .get()
}

export type RoundState = 'searching' | 'failed' | 'ready' | 'idle'

export type TopicView = {
  topic: TopicRow
  state: RoundState
  error: string | null
  /** The highest round with items; 0 before the first arrives. */
  round: number
  /** That round's still-undecided items. */
  items: { id: string; answerPl: string; glossRu: string; kind: SuggestionKind }[]
  cards: CardRow[]
  pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
}

/** Everything the topic page shows; its round state is derived, never stored (§4.4). */
export function topicView(db: Db, id: string): TopicView | null {
  const topic = db.select().from(topics).where(eq(topics.id, id)).get()
  if (!topic) return null
  const round = latestRound(db, id)
  const items = db
    .select({ id: suggestions.id, answerPl: suggestions.answerPl, glossRu: suggestions.glossRu, kind: suggestions.kind })
    .from(suggestions)
    .where(and(eq(suggestions.topicId, id), eq(suggestions.round, round), eq(suggestions.status, 'proposed')))
    .orderBy(suggestions.createdAt, sql`rowid`)
    .all()
  const latest = latestSuggestJob(db, id)
  const state: RoundState = activeSuggestJob(db, id)
    ? 'searching'
    : latest?.status === 'failed'
      ? 'failed'
      : items.length > 0
        ? 'ready'
        : 'idle'
  return {
    topic,
    state,
    error: state === 'failed' ? latest!.lastError : null,
    round,
    items,
    cards: db
      .select()
      .from(cards)
      .where(and(eq(cards.topicId, id), isNull(cards.deletedAt)))
      .orderBy(desc(cards.createdAt))
      .all(),
    pending: db
      .select({ id: captures.id, transcript: captures.transcript, status: captures.status })
      .from(captures)
      .where(and(eq(captures.topicId, id), inArray(captures.status, PENDING)))
      .orderBy(desc(captures.createdAt))
      .all() as TopicView['pending'],
  }
}

export function updateTopic(
  db: Db,
  id: string,
  patch: { name?: string; context?: string; suspendedAt?: number | null },
): TopicRow | null {
  if (!db.select({ id: topics.id }).from(topics).where(eq(topics.id, id)).get()) return null
  const set: Partial<TopicRow> = {}
  if (patch.name !== undefined) set.name = patch.name.trim()
  if (patch.context !== undefined) set.context = patch.context.trim()
  if (patch.suspendedAt !== undefined) set.suspendedAt = patch.suspendedAt
  if (Object.keys(set).length > 0) db.update(topics).set(set).where(eq(topics.id, id)).run()
  return db.select().from(topics).where(eq(topics.id, id)).get()!
}

/** `spróbuj ponownie`: the failed round again, with its own count and mix. */
export function retrySuggest(db: Db, topicId: string, now: Date): string | null {
  const latest = latestSuggestJob(db, topicId)
  if (latest?.status !== 'failed') return null
  const { count: n, mix } = parseRoundJob(latest.paramsJson)
  return enqueueSuggest(db, topicId, { count: n, mix }, now)
}
