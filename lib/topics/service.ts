import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client'
import { cards, generationJobs, suggestions, topics } from '../db/schema'
import { answerKey } from '../cards/answer-key'
import type { Suggester } from '../generate'
import { enqueueJob, type JobRow } from '../queue/jobs'
import { MIXES, mixTarget, pickRound, requestSize, type RoundParams } from './rounds'

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
