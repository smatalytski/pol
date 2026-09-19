import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client'
import { captures, cards, generationJobs, topicItems, topics } from '../db/schema'
import { answerKey } from '../cards/answer-key'
import { cardTopicName, knownCardFor, type CardRow } from '../cards/service'
import type { Suggester } from '../generate'
import { enqueueJob, type JobRow } from '../queue/jobs'
import { DEFAULT_TOPIC_ID } from './default'
import { LEVELS, MIXES, mixTarget, pickBatch, requestSize, type BatchParams, type Level, type SuggestionKind } from './rounds'

/**
 * Topics, their items and their batches (specs 2026-09-18-topic-generation
 * and 2026-09-19-topic-items). Everything here that touches the database; the
 * pure rules are in ./rounds.
 */

export type TopicRow = typeof topics.$inferSelect
export type TopicItemRow = typeof topicItems.$inferSelect

const BatchJob = z.object({
  count: z.number().int().positive(),
  mix: z.enum(MIXES),
  // A round job queued before levels existed ({"round","count","mix"}) can
  // still be waiting, or failed and awaiting a retry, when this deploys; it
  // was asked for at the only level there was. `round` is ignored.
  level: z.enum(LEVELS).default('zaawansowany'),
})

/** A `suggest` job's stored params. Throws on anything unreadable rather than guessing. */
export function parseBatchJob(paramsJson: string | null): BatchParams {
  return BatchJob.parse(JSON.parse(paramsJson ?? 'null'))
}

/** The topic's `suggest` job that is waiting or running, if any: at most one at a time (§4.5). */
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

/**
 * Queues a batch. Returns null, queueing nothing, for the default topic —
 * which is never generated for — and while the topic already has a batch in
 * flight.
 */
export function enqueueSuggest(db: Db, topicId: string, params: BatchParams, now: Date): string | null {
  if (topicId === DEFAULT_TOPIC_ID || activeSuggestJob(db, topicId)) return null
  return enqueueJob(db, { kind: 'suggest', topicId, paramsJson: JSON.stringify(params) }, now)
}

/** answer keys of live ru_to_pl cards: a batch never offers a word already in the deck. */
function deckKeys(db: Db): string[] {
  return db
    .select({ key: cards.answerKey })
    .from(cards)
    .where(and(eq(cards.type, 'ru_to_pl'), isNull(cards.deletedAt)))
    .all()
    .map((r) => r.key)
}

/** Whether this job's batch is already stored: items carry the job that proposed them. */
function batchStored(db: Db, jobId: string): boolean {
  return !!db.select({ id: topicItems.id }).from(topicItems).where(eq(topicItems.batchJobId, jobId)).get()
}

/**
 * Job `suggest`: asks for a batch and stores what survives dedup as `open`
 * items (§4.5). The exclusion list is everything the topic has ever held, in
 * any status; the deck is filtered here rather than sent in the prompt: it
 * grows without bound, the topic's history does not. A failure is thrown for
 * the queue to classify; there is nothing to fall back to.
 */
export async function runSuggest(deps: { db: Db; suggester: Suggester }, job: JobRow, now: Date): Promise<void> {
  const { db } = deps
  const params = parseBatchJob(job.paramsJson)
  const topic = job.topicId ? db.select().from(topics).where(eq(topics.id, job.topicId)).get() : undefined
  if (!topic) return
  // Already stored by a run that died before the job was marked done.
  if (batchStored(db, job.id)) return

  const history = db
    .select({ answerPl: topicItems.answerPl })
    .from(topicItems)
    .where(eq(topicItems.topicId, topic.id))
    .orderBy(topicItems.createdAt, sql`rowid`)
    .all()
    .map((r) => r.answerPl)
  const n = requestSize(params.count)
  const result = await deps.suggester.suggest({
    context: topic.context,
    count: n,
    ...mixTarget(n, params.mix),
    exclude: history,
    level: params.level,
  })

  const taken = new Set([...history.map(answerKey), ...deckKeys(db)])
  const picked = pickBatch(result.items, taken, params.count, params.mix)
  const name = result.topic_name.trim()
  db.transaction((tx) => {
    if (batchStored(tx as unknown as Db, job.id)) return
    if (name) tx.update(topics).set({ name }).where(and(eq(topics.id, topic.id), isNull(topics.name))).run()
    for (const item of picked) {
      tx.insert(topicItems)
        .values({
          id: randomUUID(),
          topicId: topic.id,
          answerPl: item.answer_pl,
          glossRu: item.gloss_ru,
          kind: item.kind,
          source: 'suggested',
          level: params.level,
          status: 'open',
          captureId: null,
          cardId: null,
          batchJobId: job.id,
          discardedAt: null,
          createdAt: now.getTime(),
        })
        .run()
    }
  })
}

/** A new topic with its first batch queued; the batch arrives through the queue. */
export function createTopic(db: Db, input: { context: string } & BatchParams, now: Date): string {
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(topics)
      .values({ id, name: null, context: input.context.trim(), suspendedAt: null, createdAt: now.getTime(), isDefault: false })
      .run()
    enqueueSuggest(tx as unknown as Db, id, { count: input.count, mix: input.mix, level: input.level }, now)
  })
  return id
}

const PENDING = ['queued', 'generating'] as const

export type TopicListRow = TopicRow & {
  /** Live cards: z kartą. */
  cardCount: number
  /** Open items: bez karty. */
  openCount: number
  /** Discarded items plus soft-deleted cards: odrzucone. */
  discardedCount: number
  pendingCount: number
  searching: boolean
}

function countsBy(rows: { topicId: string | null; n: number }[]): Map<string, number> {
  return new Map(rows.filter((r) => r.topicId !== null).map((r) => [r.topicId!, r.n]))
}

/** Every topic with its group sizes: the default topic first, then newest first. */
export function listTopics(db: Db): TopicListRow[] {
  const cardCounts = (deleted: boolean) =>
    countsBy(
      db
        .select({ topicId: cards.topicId, n: count() })
        .from(cards)
        .where(and(isNotNull(cards.topicId), deleted ? isNotNull(cards.deletedAt) : isNull(cards.deletedAt)))
        .groupBy(cards.topicId)
        .all(),
    )
  const itemCounts = (status: 'open' | 'discarded') =>
    countsBy(
      db
        .select({ topicId: topicItems.topicId, n: count() })
        .from(topicItems)
        .where(eq(topicItems.status, status))
        .groupBy(topicItems.topicId)
        .all(),
    )
  const live = cardCounts(false)
  const deleted = cardCounts(true)
  const open = itemCounts('open')
  const discarded = itemCounts('discarded')
  // A /dodaj capture is created with topic_id NULL (unchanged by this task);
  // it belongs to Ogólne the same as a topicless card does, so it is folded
  // into DEFAULT_TOPIC_ID's group here rather than dropped from every count.
  const pending = countsBy(
    db
      .select({ topicId: sql<string>`coalesce(${captures.topicId}, ${DEFAULT_TOPIC_ID})`, n: count() })
      .from(captures)
      .where(inArray(captures.status, PENDING))
      .groupBy(sql`coalesce(${captures.topicId}, ${DEFAULT_TOPIC_ID})`)
      .all(),
  )
  // A topic still searching for a batch: /tematy polls for it too, so a
  // brand-new topic does not sit at "nowy temat…" until the page happens to
  // reload.
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
    .orderBy(desc(topics.isDefault), desc(topics.createdAt))
    .all()
    .map((t) => ({
      ...t,
      cardCount: live.get(t.id) ?? 0,
      openCount: open.get(t.id) ?? 0,
      discardedCount: (discarded.get(t.id) ?? 0) + (deleted.get(t.id) ?? 0),
      pendingCount: pending.get(t.id) ?? 0,
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

export type ItemView = {
  id: string
  answerPl: string
  glossRu: string | null
  kind: SuggestionKind | null
  source: 'suggested' | 'manual'
  level: Level | null
}

export type DiscardedEntry =
  | { kind: 'item'; at: number; item: ItemView }
  | { kind: 'card'; at: number; card: CardRow }

export type BatchState = 'searching' | 'failed' | 'idle'

export type TopicView = {
  topic: TopicRow
  groups: { carded: CardRow[]; open: ItemView[]; discarded: DiscardedEntry[] }
  pending: { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
  batch: { state: BatchState; error: string | null }
}

const itemView = (i: TopicItemRow): ItemView => ({
  id: i.id,
  answerPl: i.answerPl,
  glossRu: i.glossRu,
  kind: i.kind,
  source: i.source,
  level: i.level,
})

/**
 * Everything the topic page shows (spec 2026-09-19-topic-items §3.3): its
 * three groups, its pending captures and its batch state. The state is
 * derived, never stored. `carded` items are in no group.
 */
export function topicView(db: Db, id: string): TopicView | null {
  const topic = db.select().from(topics).where(eq(topics.id, id)).get()
  if (!topic) return null
  const items = (status: 'open' | 'discarded') =>
    db
      .select()
      .from(topicItems)
      .where(and(eq(topicItems.topicId, id), eq(topicItems.status, status)))
      .orderBy(topicItems.createdAt, sql`rowid`)
      .all()
  const discarded: DiscardedEntry[] = [
    ...items('discarded').map((i): DiscardedEntry => ({ kind: 'item', at: i.discardedAt ?? i.createdAt, item: itemView(i) })),
    ...db
      .select()
      .from(cards)
      .where(and(eq(cards.topicId, id), isNotNull(cards.deletedAt)))
      .all()
      .map((c): DiscardedEntry => ({ kind: 'card', at: c.deletedAt!, card: c })),
  ].sort((a, b) => b.at - a.at)
  const latest = latestSuggestJob(db, id)
  const state: BatchState = activeSuggestJob(db, id) ? 'searching' : latest?.status === 'failed' ? 'failed' : 'idle'
  return {
    topic,
    groups: {
      carded: db
        .select()
        .from(cards)
        .where(and(eq(cards.topicId, id), isNull(cards.deletedAt)))
        .orderBy(desc(cards.createdAt))
        .all(),
      // Oldest first, so a batch reads in the model's order (most useful first).
      open: items('open').map(itemView),
      discarded,
    },
    // A /dodaj capture has topic_id NULL and belongs to Ogólne (see listTopics).
    pending: db
      .select({ id: captures.id, transcript: captures.transcript, status: captures.status })
      .from(captures)
      .where(
        and(
          id === DEFAULT_TOPIC_ID ? or(eq(captures.topicId, id), isNull(captures.topicId)) : eq(captures.topicId, id),
          inArray(captures.status, PENDING),
        ),
      )
      .orderBy(desc(captures.createdAt))
      .all() as TopicView['pending'],
    batch: { state, error: state === 'failed' ? latest!.lastError : null },
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

/** `spróbuj ponownie`: the failed batch again, with its own count, mix and level. */
export function retrySuggest(db: Db, topicId: string, now: Date): string | null {
  const latest = latestSuggestJob(db, topicId)
  if (latest?.status !== 'failed') return null
  return enqueueSuggest(db, topicId, parseBatchJob(latest.paramsJson), now)
}

/**
 * `+ karta` on an open item (spec 2026-09-19-topic-items §4.1): turns it into
 * an audio-less capture with an ordinary `new` job, exactly what accepting a
 * recording did before, and marks the item carded with that capture linked.
 * Null, queueing nothing, unless the item is open and in this topic — the
 * caller turns that into a 404. One transaction, so an item is never left
 * carded without its capture, or a capture created without its item updated.
 */
export function cardItem(db: Db, topicId: string, itemId: string, now: Date): { captureId: string } | null {
  return db.transaction((tx) => {
    const item = tx
      .select()
      .from(topicItems)
      .where(and(eq(topicItems.id, itemId), eq(topicItems.topicId, topicId), eq(topicItems.status, 'open')))
      .get()
    if (!item) return null
    const captureId = randomUUID()
    tx.insert(captures)
      .values({
        id: captureId,
        audioMediaId: null,
        transcript: item.answerPl,
        status: 'queued',
        error: null,
        generationJson: null,
        cardId: null,
        createdAt: now.getTime(),
        transcribedAt: null,
        duplicateOf: null,
        topicId,
        glossRu: item.glossRu,
        lang: null,
      })
      .run()
    enqueueJob(tx as unknown as Db, { kind: 'new', captureId }, now)
    tx.update(topicItems).set({ status: 'carded', captureId }).where(eq(topicItems.id, itemId)).run()
    return { captureId }
  })
}

/** `✕` on an item in bez karty (spec §4.2): open only, becomes discarded with a timestamp. */
export function discardItem(db: Db, topicId: string, itemId: string, now: Date): boolean {
  const item = db
    .select({ id: topicItems.id })
    .from(topicItems)
    .where(and(eq(topicItems.id, itemId), eq(topicItems.topicId, topicId), eq(topicItems.status, 'open')))
    .get()
  if (!item) return false
  db.update(topicItems).set({ status: 'discarded', discardedAt: now.getTime() }).where(eq(topicItems.id, itemId)).run()
  return true
}

/** `przywróć` on an item in odrzucone (spec §4.3): discarded only, goes back to open. */
export function restoreItem(db: Db, topicId: string, itemId: string): boolean {
  const item = db
    .select({ id: topicItems.id })
    .from(topicItems)
    .where(and(eq(topicItems.id, itemId), eq(topicItems.topicId, topicId), eq(topicItems.status, 'discarded')))
    .get()
  if (!item) return false
  db.update(topicItems).set({ status: 'open', discardedAt: null }).where(eq(topicItems.id, itemId)).run()
  return true
}

/** `temat: …` on an item (spec §4.4): sets its topic without touching its group. False for an unknown item or topic. */
export function moveItem(db: Db, itemId: string, toTopicId: string): boolean {
  if (!db.select({ id: topics.id }).from(topics).where(eq(topics.id, toTopicId)).get()) return false
  return db.update(topicItems).set({ topicId: toTopicId }).where(eq(topicItems.id, itemId)).run().changes > 0
}

/**
 * `dodaj` on the hand-add bar (spec §4.6). Trims the text and refuses an
 * empty one, a word the topic already holds (any status, compared by
 * `answerKey` in JS like `searchCards`), or a word already in the deck
 * (`knownCardFor`, so a Cyrillic entry matches against cards' Russian
 * prompts too). Otherwise stores it as a manual open item with no gloss,
 * kind or level — a hand-added word carries none of a suggestion's metadata.
 */
export function addManualItem(
  db: Db,
  topicId: string,
  text: string,
  now: Date,
):
  | { ok: true; item: ItemView }
  | { ok: false; reason: 'empty' | 'not-found' }
  | { ok: false; reason: 'in-topic' }
  | { ok: false; reason: 'in-deck'; topicName: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (!db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId)).get()) return { ok: false, reason: 'not-found' }

  const key = answerKey(trimmed)
  const inTopic = db
    .select({ answerPl: topicItems.answerPl })
    .from(topicItems)
    .where(eq(topicItems.topicId, topicId))
    .all()
    .some((i) => answerKey(i.answerPl) === key)
  if (inTopic) return { ok: false, reason: 'in-topic' }

  const cardId = knownCardFor(db, trimmed)
  if (cardId) return { ok: false, reason: 'in-deck', topicName: cardTopicName(db, cardId) }

  const id = randomUUID()
  db.insert(topicItems)
    .values({
      id,
      topicId,
      answerPl: trimmed,
      glossRu: null,
      kind: null,
      source: 'manual',
      level: null,
      status: 'open',
      captureId: null,
      cardId: null,
      batchJobId: null,
      discardedAt: null,
      createdAt: now.getTime(),
    })
    .run()
  return { ok: true, item: itemView(db.select().from(topicItems).where(eq(topicItems.id, id)).get()!) }
}
