import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, generationJobs } from '../db/schema'
import { GenerationError } from '../generate'
import { backoffMs } from './backoff'
import { approvedIds, type ReviewRow } from './review'

/**
 * The generation queue (spec 2026-09-18-generation-queue §5–§6): storage,
 * promotion of approved recordings, crash recovery, and running one job
 * through handlers the caller supplies — so this module knows nothing about
 * cards or Gemini, and every rule here is testable with fakes.
 */

export type JobKind = 'new' | 'regenerate' | 'rerecognized'
export type JobRow = typeof generationJobs.$inferSelect

/**
 * A non-retryable failure gets this many attempts, then the job gives up
 * (§6). Counted by `failures`, not `attempts`: a retryable failure never
 * brings a job closer to this limit, however many of them precede it.
 */
export const MAX_ATTEMPTS_NON_RETRYABLE = 3

export function enqueueJob(
  db: Db,
  input: { kind: JobKind; captureId?: string | null; cardId?: string | null },
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

/**
 * Whether a job of this kind for this recording is waiting to run. Per kind
 * and per recording, not per card: a pending `regenerate` on the same card
 * works from answer_pl and would never see a new transcript, so it must not
 * stop a re-recognition from queueing its own `rerecognized` job. Queued
 * only, not running: a running job has already read its inputs.
 */
export function hasQueuedJobFor(db: Db, kind: JobKind, captureId: string): boolean {
  return !!db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, kind),
        eq(generationJobs.captureId, captureId),
        eq(generationJobs.status, 'queued'),
      ),
    )
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
 * Every approved recording leaves review: a word already in the deck becomes
 * 'duplicate' and is never queued (§4); any other becomes 'queued' with a
 * `new` job. One transaction, so a recording is never queued without its job.
 * Processed oldest-transcribed-first (ties broken by createdAt) so that, when
 * several recordings are approved in the same tick, their jobs are inserted
 * in a fixed, sensible order rather than whatever order a Set yields.
 */
export function promoteApproved(db: Db, now: Date): { queued: string[]; duplicates: string[] } {
  const rows = underReview(db)
  const approved = approvedIds(rows, now.getTime())
  const ordered = rows
    .filter((r) => approved.has(r.id))
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
      if (row.duplicateOf) {
        tx.update(captures).set({ status: 'duplicate' }).where(eq(captures.id, id)).run()
        duplicates.push(id)
      } else {
        tx.update(captures).set({ status: 'queued' }).where(eq(captures.id, id)).run()
        enqueueJob(tx as unknown as Db, { kind: 'new', captureId: id }, now)
        queued.push(id)
      }
    }
  })
  return { queued, duplicates }
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
 * Runs at most one job: the oldest queued one that is due. A retryable failure
 * re-queues it with backoff AND pauses the whole queue for the same delay,
 * because the quota is per project — and never counts against the give-up
 * limit, however many of them occur. A non-retryable one gets
 * MAX_ATTEMPTS_NON_RETRYABLE such failures without pausing, then its
 * handler's giveUp runs once. `attempts` counts every failed attempt of
 * either kind and drives backoffMs; `failures` counts only non-retryable ones
 * and drives the give-up decision.
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
    // createdAt can tie when promoteApproved inserts several jobs in one
    // tick; rowid (insertion order) breaks the tie deterministically.
    .orderBy(asc(generationJobs.createdAt), sql`rowid`)
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
    handlers[job.kind].giveUp(job, message, now)
    setJob(db, job.id, { status: 'failed', attempts, failures, lastError: message, finishedAt: t })
    return 'gave-up'
  }
}
