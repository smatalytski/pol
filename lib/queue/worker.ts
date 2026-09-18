import { jobHandlers, type CaptureDeps } from '../capture/pipeline'
import { promoteApproved, recoverRunning, runNextJob, type RunnerState, type RunOutcome } from './jobs'

export const TICK_MS = 1_000

/** One pass (spec 2026-09-18-generation-queue §5): promote approved recordings, then run at most one due job. */
export async function tick(deps: CaptureDeps, state: RunnerState, now: Date, random: () => number): Promise<RunOutcome> {
  promoteApproved(deps.db, now)
  return runNextJob(deps.db, jobHandlers(deps), state, now, random)
}

declare global {
  var __fiszkiGenerationWorker: boolean | undefined
}

/**
 * Starts the loop once per server process. The providers are built lazily and
 * rebuilt after a failure, so a missing FISZKI_MODEL at boot is logged on every
 * tick instead of killing the worker for the life of the process. Ticks never
 * overlap: a slow Gemini call simply delays the next one.
 */
export async function startWorker(): Promise<void> {
  if (globalThis.__fiszkiGenerationWorker) return
  globalThis.__fiszkiGenerationWorker = true
  const { db } = await import('../db/client')
  const { getTranscriber } = await import('../transcribe')
  const { getGenerator } = await import('../generate')
  console.log(`generation worker started (recovered ${recoverRunning(db)} interrupted job(s))`)
  const state: RunnerState = { pausedUntil: 0 }
  let deps: CaptureDeps | null = null
  let busy = false
  setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        deps ??= { db, transcriber: getTranscriber(), generator: getGenerator() }
        await tick(deps, state, new Date(), Math.random)
      } catch (err) {
        deps = null
        console.error('generation worker tick failed', err)
      } finally {
        busy = false
      }
    })()
  }, TICK_MS)
}
