import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { captures, generationJobs } from '../db/schema'
import { GenerationError } from '../generate'
import {
  activeJobCardIds, enqueueJob, hasActiveJob, promoteApproved, recoverRunning, runNextJob,
  type JobHandlers,
} from './jobs'

const T = 1_000_000
const at = (ms: number) => new Date(T + ms)
const zero = () => 0

function capture(db: ReturnType<typeof createTestDb>['db'], id: string, over: Partial<typeof captures.$inferInsert> = {}) {
  db.insert(captures).values({
    id, audioMediaId: null, transcript: id, status: 'transcribed', error: null, generationJson: null,
    cardId: null, createdAt: T, transcribedAt: T, duplicateOf: null, ...over,
  }).run()
}

function fakeHandlers(run = vi.fn().mockResolvedValue(undefined)) {
  const giveUp = vi.fn()
  const h = { run, giveUp }
  return { handlers: { new: h, regenerate: h, suggest: h } as JobHandlers, run, giveUp }
}

const job = (db: ReturnType<typeof createTestDb>['db'], id: string) =>
  db.select().from(generationJobs).where(eq(generationJobs.id, id)).get()!

describe('runNextJob', () => {
  it('runs the oldest due job and marks it done', async () => {
    const { db } = createTestDb()
    const first = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const second = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(1))
    const { handlers, run } = fakeHandlers()
    expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)).toBe('done')
    expect(run.mock.calls[0][0].id).toBe(first)
    expect(job(db, first).status).toBe('done')
    expect(job(db, second).status).toBe('queued')
  })

  // Determinism: promoteApproved can insert two jobs with the same createdAt
  // in one tick. The tie must break on insertion order (rowid), not be
  // left to whatever order SQLite happens to return.
  it('breaks a tie on createdAt by picking the job inserted first', async () => {
    const { db } = createTestDb()
    const first = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(5))
    const second = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(5))
    const { handlers, run } = fakeHandlers()
    expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)).toBe('done')
    expect(run.mock.calls[0][0].id).toBe(first)
    expect(job(db, second).status).toBe('queued')
  })

  it('is idle when nothing is due', async () => {
    const { db } = createTestDb()
    const { handlers } = fakeHandlers()
    expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(0), zero)).toBe('idle')
  })

  // Spec §6: the quota is per project, so a retryable failure pauses the whole
  // queue — the next job is not tried into the same exhausted quota.
  it('re-queues a 429 with backoff and pauses every job until it passes', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'regenerate' }, at(0))
    enqueueJob(db, { kind: 'regenerate' }, at(1))
    const run = vi.fn().mockRejectedValueOnce(new GenerationError('429', { retryable: true })).mockResolvedValue(undefined)
    const { handlers } = fakeHandlers(run)
    const state = { pausedUntil: 0 }

    expect(await runNextJob(db, handlers, state, at(10), zero)).toBe('retry')
    expect(job(db, a)).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: T + 10 + 2_500, lastError: '429' })
    expect(state.pausedUntil).toBe(T + 10 + 2_500)

    expect(await runNextJob(db, handlers, state, at(2_000), zero)).toBe('paused')
    expect(run).toHaveBeenCalledTimes(1)

    expect(await runNextJob(db, handlers, state, at(2_510), zero)).toBe('done')
    expect(job(db, a).status).toBe('done')
  })

  it('retries a 429 indefinitely rather than giving up', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'regenerate' }, at(0))
    const { handlers, giveUp } = fakeHandlers(vi.fn().mockRejectedValue(new GenerationError('429', { retryable: true })))
    const state = { pausedUntil: 0 }
    for (let i = 0; i < 6; i++) {
      await runNextJob(db, handlers, state, new Date(Math.max(state.pausedUntil, T)), zero)
    }
    expect(job(db, a)).toMatchObject({ status: 'queued', attempts: 6 })
    expect(giveUp).not.toHaveBeenCalled()
  })

  it('gives a non-retryable failure 3 attempts without pausing, then gives up once', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'new', captureId: null }, at(0))
    const { handlers, giveUp } = fakeHandlers(vi.fn().mockRejectedValue(new GenerationError('unusable')))
    const state = { pausedUntil: 0 }

    expect(await runNextJob(db, handlers, state, at(0), zero)).toBe('retry')
    expect(state.pausedUntil).toBe(0)
    expect(await runNextJob(db, handlers, state, at(3_000), zero)).toBe('retry')
    expect(await runNextJob(db, handlers, state, at(10_000), zero)).toBe('gave-up')

    expect(giveUp).toHaveBeenCalledTimes(1)
    expect(giveUp.mock.calls[0][1]).toBe('unusable')
    expect(job(db, a)).toMatchObject({
      status: 'failed', attempts: 3, failures: 3, lastError: 'unusable', finishedAt: T + 10_000,
    })
  })

  // Spec §6: retryable failures never count against the 3-attempt limit — only
  // a non-retryable reply brings the job closer to giving up.
  it('does not count a 429 against the non-retryable attempt limit', async () => {
    const { db } = createTestDb()
    const a = enqueueJob(db, { kind: 'regenerate' }, at(0))
    const run = vi
      .fn()
      .mockRejectedValueOnce(new GenerationError('429', { retryable: true }))
      .mockRejectedValueOnce(new GenerationError('429', { retryable: true }))
      .mockRejectedValue(new GenerationError('unusable'))
    const { handlers, giveUp } = fakeHandlers(run)
    const state = { pausedUntil: 0 }

    expect(await runNextJob(db, handlers, state, at(0), zero)).toBe('retry')
    expect(await runNextJob(db, handlers, state, new Date(state.pausedUntil), zero)).toBe('retry')
    expect(await runNextJob(db, handlers, state, new Date(state.pausedUntil), zero)).toBe('retry')

    expect(giveUp).not.toHaveBeenCalled()
    expect(job(db, a)).toMatchObject({ status: 'queued', attempts: 3, failures: 1, lastError: 'unusable' })
  })

  // A throwing giveUp must not strand the job 'running' until the next restart.
  it('still fails the job, and logs, when giveUp itself throws', async () => {
    const { db } = createTestDb()
    const id = enqueueJob(db, { kind: 'regenerate' }, at(0))
    db.update(generationJobs).set({ failures: 2, attempts: 2 }).where(eq(generationJobs.id, id)).run()
    const { handlers, giveUp } = fakeHandlers(vi.fn().mockRejectedValue(new Error('unusable')))
    giveUp.mockImplementation(() => {
      throw new Error('giveUp broke')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await runNextJob(db, handlers, { pausedUntil: 0 }, at(0), zero)).toBe('gave-up')
      expect(job(db, id)).toMatchObject({ status: 'failed', lastError: 'unusable', finishedAt: T })
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(id), expect.objectContaining({ message: 'giveUp broke' }))
    } finally {
      errors.mockRestore()
    }
  })

  it('treats an error that is not a GenerationError as non-retryable', async () => {
    const { db } = createTestDb()
    enqueueJob(db, { kind: 'regenerate' }, at(0))
    const { handlers } = fakeHandlers(vi.fn().mockRejectedValue(new Error('no such card')))
    const state = { pausedUntil: 0 }
    expect(await runNextJob(db, handlers, state, at(0), zero)).toBe('retry')
    expect(state.pausedUntil).toBe(0)
  })

  // A round is something you are watching the screen for; a card is not
  // (spec 2026-09-18-topic-generation §6.1).
  it('takes a due suggest job before an older job of another kind', async () => {
    const { db } = createTestDb()
    const older = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const round = enqueueJob(db, { kind: 'suggest', paramsJson: '{}' }, at(5))
    const { handlers, run } = fakeHandlers()
    await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)
    expect(run.mock.calls[0][0].id).toBe(round)
    expect(job(db, older).status).toBe('queued')
  })

  it('still respects next_attempt_at for a suggest job', async () => {
    const { db } = createTestDb()
    const older = enqueueJob(db, { kind: 'regenerate', cardId: null }, at(0))
    const round = enqueueJob(db, { kind: 'suggest', paramsJson: '{}' }, at(5))
    db.update(generationJobs).set({ nextAttemptAt: T + 1_000 }).where(eq(generationJobs.id, round)).run()
    const { handlers, run } = fakeHandlers()
    await runNextJob(db, handlers, { pausedUntil: 0 }, at(10), zero)
    expect(run.mock.calls[0][0].id).toBe(older)
  })

  it('shows a new recording as generating while its job runs, and queued again after a 429', async () => {
    const { db } = createTestDb()
    capture(db, 'c1', { status: 'queued' })
    enqueueJob(db, { kind: 'new', captureId: 'c1' }, at(0))
    let during = ''
    const run = vi.fn(async () => {
      during = db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status
      throw new GenerationError('429', { retryable: true })
    })
    await runNextJob(db, fakeHandlers(run).handlers, { pausedUntil: 0 }, at(0), zero)
    expect(during).toBe('generating')
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
  })
})

describe('promoteApproved', () => {
  it('queues a new word once its review window has passed, and leaves a fresh one', () => {
    const { db } = createTestDb()
    capture(db, 'old', { transcribedAt: T })
    capture(db, 'fresh', { transcribedAt: T + 5_000 })
    expect(promoteApproved(db, at(10_000))).toEqual({ queued: ['old'], duplicates: [] })
    expect(db.select().from(captures).where(eq(captures.id, 'old')).get()!.status).toBe('queued')
    expect(db.select().from(captures).where(eq(captures.id, 'fresh')).get()!.status).toBe('transcribed')
    const jobs = db.select().from(generationJobs).all()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: 'new', captureId: 'old', status: 'queued' })
  })

  // Spec §4: a word already in the deck is never queued — no Gemini call, no card.
  it('marks a już masz word duplicate and queues nothing', () => {
    const { db, sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due) VALUES ('k', 'ru_to_pl', 'kot', 'kot', 'ready', 1, 1, 1)`).run()
    capture(db, 'dup', { duplicateOf: 'k' })
    expect(promoteApproved(db, at(10_000))).toEqual({ queued: [], duplicates: ['dup'] })
    expect(db.select().from(generationJobs).all()).toHaveLength(0)
    expect(db.select().from(captures).where(eq(captures.id, 'dup')).get()!.status).toBe('duplicate')
  })

  // The card it matched was deleted during the window: there is nothing to
  // be a duplicate of any more, so the word is generated after all.
  it('queues a już masz word as new when the card it matched was deleted', () => {
    const { db, sqlite } = createTestDb()
    sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due, deleted_at) VALUES ('k', 'ru_to_pl', 'kot', 'kot', 'ready', 1, 1, 1, 5)`).run()
    capture(db, 'dup', { duplicateOf: 'k' })
    expect(promoteApproved(db, at(10_000))).toEqual({ queued: ['dup'], duplicates: [] })
    expect(db.select().from(captures).where(eq(captures.id, 'dup')).get()).toMatchObject({ status: 'queued', duplicateOf: null })
    expect(db.select().from(generationJobs).all()).toEqual([expect.objectContaining({ kind: 'new', captureId: 'dup' })])
  })

  it('promotes a recording only once', () => {
    const { db } = createTestDb()
    capture(db, 'old')
    promoteApproved(db, at(10_000))
    promoteApproved(db, at(20_000))
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  // Determinism: two recordings can become approved in the same tick (e.g.
  // both past their 10 s window); their jobs must still be picked up in a
  // fixed, sensible order rather than whatever order a Set happened to yield.
  it('promotes oldest-transcribed-first, so the older job is inserted first', () => {
    const { db } = createTestDb()
    capture(db, 'younger', { transcribedAt: T + 1_000, createdAt: T + 1_000 })
    capture(db, 'older', { transcribedAt: T, createdAt: T })
    expect(promoteApproved(db, at(20_000))).toEqual({ queued: ['older', 'younger'], duplicates: [] })
    const jobs = db.select().from(generationJobs).all()
    expect(jobs.map((j) => j.captureId)).toEqual(['older', 'younger'])
  })
})

describe('recoverRunning', () => {
  it('returns interrupted jobs and their recordings to the queue', () => {
    const { db } = createTestDb()
    capture(db, 'c1', { status: 'generating' })
    const id = enqueueJob(db, { kind: 'new', captureId: 'c1' }, at(0))
    db.update(generationJobs).set({ status: 'running' }).where(eq(generationJobs.id, id)).run()
    expect(recoverRunning(db)).toBe(1)
    expect(job(db, id).status).toBe('queued')
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
  })
})

describe('active jobs', () => {
  it('reports cards with a queued or running job, and not finished ones', () => {
    const { db, sqlite } = createTestDb()
    for (const id of ['a', 'b', 'c']) {
      sqlite.prepare(`INSERT INTO cards (id, type, answer_pl, answer_key, status, created_at, updated_at, due) VALUES (?, 'ru_to_pl', ?, ?, 'needs_input', 1, 1, 1)`).run(id, id, id)
    }
    enqueueJob(db, { kind: 'regenerate', cardId: 'a' }, at(0))
    const done = enqueueJob(db, { kind: 'regenerate', cardId: 'b' }, at(0))
    db.update(generationJobs).set({ status: 'done' }).where(eq(generationJobs.id, done)).run()
    expect(hasActiveJob(db, 'a')).toBe(true)
    expect(hasActiveJob(db, 'b')).toBe(false)
    expect(activeJobCardIds(db)).toEqual(['a'])
  })
})
