import type { Db } from '../db/client'
import type { Generator } from '../generate'
import type { Transcriber } from '../transcribe'
import { jobHandlers, recognizeStranded } from '../capture/pipeline'
import { promoteApproved, recoverRunning, runNextJob, type RunnerState, type RunOutcome } from './jobs'

export const TICK_MS = 1_000

export type Providers = { transcriber: Transcriber; generator: Generator }

/**
 * One pass of the worker (spec 2026-09-18-generation-queue §5): promote
 * approved recordings, then run at most one due job. Promotion runs on every
 * tick, even while a job from an earlier tick is still running: it is
 * synchronous, and skipping it would leave an approved word on neither
 * screen (gone from /dodaj, not yet pending on /fiszki) for as long as a slow
 * Gemini call takes. Only the job run is guarded: while one is in flight a
 * tick answers 'busy' after promoting. `providers` is called on every tick
 * that runs a job, so the caller can build them lazily and rebuild them after
 * `onError`.
 */
export function createTicker(opts: {
  db: Db
  providers: () => Providers
  state: RunnerState
  random: () => number
  onError: (err: unknown) => void
}): (now: Date) => Promise<RunOutcome | 'busy' | 'error'> {
  const { db, state, random, onError } = opts
  let busy = false
  return async (now) => {
    try {
      promoteApproved(db, now)
    } catch (err) {
      onError(err)
    }
    if (busy) return 'busy'
    busy = true
    try {
      return await runNextJob(db, jobHandlers({ db, ...opts.providers() }), state, now, random)
    } catch (err) {
      onError(err)
      return 'error'
    } finally {
      busy = false
    }
  }
}

declare global {
  var __fiszkiGenerationWorker: boolean | undefined
}

/**
 * Starts the loop once per server process, after returning interrupted jobs
 * to the queue and re-running recognition for recordings a restart left
 * 'uploaded' (recognizeStranded). The providers are built lazily and
 * rebuilt after a failure, so a missing FISZKI_MODEL at boot is logged on every
 * tick instead of killing the worker for the life of the process. A slow
 * Gemini call simply delays the next job.
 */
export async function startWorker(): Promise<void> {
  if (globalThis.__fiszkiGenerationWorker) return
  globalThis.__fiszkiGenerationWorker = true
  const { db } = await import('../db/client')
  const { getTranscriber } = await import('../transcribe')
  const { getGenerator } = await import('../generate')
  console.log(`generation worker started (recovered ${recoverRunning(db)} interrupted job(s))`)
  // Not awaited: Speech-to-Text for a backlog must not hold up the first tick.
  void (async () => {
    try {
      await recognizeStranded({ db, transcriber: getTranscriber(), clock: () => new Date() })
    } catch (err) {
      console.error('stranded capture recognition failed to start', err)
    }
  })()
  let providers: Providers | null = null
  const tick = createTicker({
    db,
    providers: () => (providers ??= { transcriber: getTranscriber(), generator: getGenerator() }),
    state: { pausedUntil: 0 },
    random: Math.random,
    onError: (err) => {
      providers = null
      console.error('generation worker tick failed', err)
    },
  })
  setInterval(() => void tick(new Date()), TICK_MS)
}
