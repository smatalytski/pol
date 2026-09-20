import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, cards, generationJobs } from '../db/schema'
import { GenerationError } from '../generate'
import { backoffMs } from './backoff'
import { approvedIds, type ReviewRow } from './review'

/**
 * The generation queue (spec 2026-09-18-generation-queue §5–§6): storage,
 * promotion of approved recordings, crash recovery, and running one job
 * through handlers the caller supplies — so this module knows nothing about
 * cards or Gemini, and every rule here is testable with fakes.
 */

export type JobKind = 'new' | 'regenerate' | 'suggest'
export type JobRow = typeof generationJobs.$inferSelect

/**
 * A non-retryable failure gets this many attempts, then the job gives up
 * (§6). Counted by `failures`, not `attempts`: a retryable failure never
 * brings a job closer to this limit, however many of them precede it.
 */
export const MAX_ATTEMPTS_NON_RETRYABLE = 3

export function enqueueJob(
  db: Db,
  input: {
    kind: JobKind
    captureId?: string | null
    cardId?: string | null
    topicId?: string | null
    paramsJson?: string | null
  },
  now: Date,
): string {
  const id = randomUUID()
  db.insert(generationJobs)
    .values({
      id,
      kind: input.kind,
      captureId: input.captureId ?? null,
      cardId: input.cardId ?? null,
      status: 'queued',
      attempts: 0,
      failures: 0,
      nextAttemptAt: now.getTime(),
      lastError: null,
      createdAt: now.getTime(),
      finishedAt: null,
      topicId: input.topicId ?? null,
      paramsJson: input.paramsJson ?? null,
    })
    .run()
  return id
}

const ACTIVE = ['queued', 'running'] as const

export function hasActiveJob(db: Db, cardId: string): boolean {
  return !!db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(eq(generationJobs.cardId, cardId), inArray(generationJobs.status, ACTIVE)))
    .get()
}

export function activeJobCardIds(db: Db): string[] {
  const rows = db
    .selectDistinct({ cardId: generationJobs.cardId })
    .from(generationJobs)
    .where(and(inArray(generationJobs.status, ACTIVE), isNotNull(generationJobs.cardId)))
    .all()
  return rows.map((r) => r.cardId!).sort()
}

/** Recordings still under review: transcribed and not yet promoted (§3). */
export function underReview(db: Db): ReviewRow[] {
  return db
    .select({ id: captures.id, transcribedAt: captures.transcribedAt, createdAt: captures.createdAt })
    .from(captures)
    .where(and(eq(captures.status, 'transcribed'), isNotNull(captures.transcribedAt)))
    .all()
    .map((r) => ({ id: r.id, transcribedAt: r.transcribedAt!, createdAt: r.createdAt }))
}

/**
 * Promote exactly these recordings, whatever the clock says: a word already
 * in the deck becomes 'duplicate' and is never queued (§4); any other becomes
 * 'queued' with a `new` job. A word whose matched card was deleted during the
 * window counts as new, and its stale duplicate_of is cleared. One
 * transaction, so a recording is never queued without its job.
 * Processed oldest-transcribed-first (ties broken by createdAt) so that, when
 * several recordings are promoted at once, their jobs are inserted in a fixed,
 * sensible order rather than whatever order a Set yields.
 * Ids that are not under review are skipped, which is what makes promoting
 * the same recording twice a no-op rather than a second card.
 */
export function promoteIds(db: Db, ids: readonly string[], now: Date): { queued: string[]; duplicates: string[] } {
  const wanted = new Set(ids)
  const ordered = underReview(db)
    .filter((r) => wanted.has(r.id))
    .sort((a, b) => a.transcribedAt - b.transcribedAt || a.createdAt - b.createdAt)
  const queued: string[] = []
  const duplicates: string[] = []
  db.transaction((tx) => {
    for (const { id } of ordered) {
      const row = tx
        .select({ duplicateOf: captures.duplicateOf })
        .from(captures)
        .where(and(eq(captures.id, id), eq(captures.status, 'transcribed')))
        .get()
      if (!row) continue
      const liveMatch =
        row.duplicateOf &&
        tx
          .select({ id: cards.id })
          .from(cards)
          .where(and(eq(cards.id, row.duplicateOf), isNull(cards.deletedAt)))
          .get()
      if (liveMatch) {
        tx.update(captures).set({ status: 'duplicate' }).where(eq(captures.id, id)).run()
        duplicates.push(id)
      } else {
        tx.update(captures).set({ status: 'queued', duplicateOf: null }).where(eq(captures.id, id)).run()
        enqueueJob(tx as unknown as Db, { kind: 'new', captureId: id }, now)
        queued.push(id)
      }
    }
  })
  return { queued, duplicates }
}

/**
 * Every recording whose review window is up leaves review (§3). The worker's
 * entry point; `promoteIds` does the work.
 * `underReview` is read twice — once here to decide, once inside `promoteIds`
 * to order — which is two cheap indexed selects and keeps the ordering rule in
 * exactly one place.
 */
export function promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] } {
  return promoteIds(db, [...approvedIds(underReview(db), now.getTime())], now)
}

/** At startup: a job left 'running' was interrupted; it goes back to the queue (§6). */
export function recoverRunning(db: Db): number {
  const running = db.select().from(generationJobs).where(eq(generationJobs.status, 'running')).all()
  db.transaction((tx) => {
    for (const job of running) {
      tx.update(generationJobs).set({ status: 'queued' }).where(eq(generationJobs.id, job.id)).run()
      if (job.kind === 'new' && job.captureId) {
        tx.update(captures).set({ status: 'queued' }).where(eq(captures.id, job.captureId)).run()
      }
    }
  })
  return running.length
}

export type JobHandler = {
  run(job: JobRow, now: Date): Promise<void>
  /** Called once, when a job gives up after its last non-retryable failure (§6). */
  giveUp(job: JobRow, lastError: string, now: Date): void
}
export type JobHandlers = Record<JobKind, JobHandler>

/** Lives in the worker's memory; a restart clears it, costing at most one extra 429 (§6). */
export type RunnerState = { pausedUntil: number }
export type RunOutcome = 'paused' | 'idle' | 'done' | 'retry' | 'gave-up'

function setJob(db: Db, id: string, patch: Partial<JobRow>): void {
  db.update(generationJobs).set(patch).where(eq(generationJobs.id, id)).run()
}

function setNewCaptureStatus(db: Db, job: JobRow, status: 'queued' | 'generating'): void {
  if (job.kind === 'new' && job.captureId) {
    db.update(captures).set({ status }).where(eq(captures.id, job.captureId)).run()
  }
}

/**
 * Runs at most one job: a due `suggest` job if there is one, else the oldest
 * due job. A retryable failure re-queues it with backoff AND pauses the whole
 * queue for the same delay, because the quota is per project — and never
 * counts against the give-up limit, however many of them occur. A
 * non-retryable one gets MAX_ATTEMPTS_NON_RETRYABLE such failures without
 * pausing, then its handler's giveUp runs once. `attempts` counts every
 * failed attempt of either kind and drives backoffMs; `failures` counts only
 * non-retryable ones and drives the give-up decision.
 */
export async function runNextJob(
  db: Db,
  handlers: JobHandlers,
  state: RunnerState,
  now: Date,
  random: () => number,
): Promise<RunOutcome> {
  const t = now.getTime()
  if (t < state.pausedUntil) return 'paused'
  const job = db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.status, 'queued'), lte(generationJobs.nextAttemptAt, t)))
    // A `suggest` job first: it is a batch someone is watching the screen
    // for (spec 2026-09-18-topic-generation §6.1). Then oldest first;
    // createdAt can tie when promoteApproved inserts several jobs in one
    // tick, and rowid (insertion order) breaks the tie deterministically.
    .orderBy(sql`CASE WHEN ${generationJobs.kind} = 'suggest' THEN 0 ELSE 1 END`, asc(generationJobs.createdAt), sql`rowid`)
    .get()
  if (!job) return 'idle'

  setJob(db, job.id, { status: 'running' })
  setNewCaptureStatus(db, job, 'generating')
  try {
    await handlers[job.kind].run(job, now)
    setJob(db, job.id, { status: 'done', finishedAt: t, lastError: null })
    return 'done'
  } catch (err) {
    const attempts = job.attempts + 1
    const message = String((err as Error)?.message ?? err)
    const retryable = err instanceof GenerationError && err.retryable
    const failures = retryable ? job.failures : job.failures + 1
    if (retryable || failures < MAX_ATTEMPTS_NON_RETRYABLE) {
      const next = t + backoffMs(attempts, random)
      if (retryable) state.pausedUntil = next
      setJob(db, job.id, { status: 'queued', attempts, failures, nextAttemptAt: next, lastError: message })
      setNewCaptureStatus(db, job, 'queued')
      return 'retry'
    }
    try {
      handlers[job.kind].giveUp(job, message, now)
    } catch (giveUpErr) {
      // Logged, not rethrown: the job has still given up. Left 'running', it
      // would show its card or recording as in flight until the next restart.
      console.error(`generation job ${job.id} failed to give up`, giveUpErr)
    }
    setJob(db, job.id, { status: 'failed', attempts, failures, lastError: message, finishedAt: t })
    return 'gave-up'
  }
}
