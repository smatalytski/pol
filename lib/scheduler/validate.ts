import type { SchedulerState } from './index'

export class InvalidSchedulerStateError extends Error {
  constructor(field: string) {
    super(`invalid scheduler state: ${field}`)
    this.name = 'InvalidSchedulerStateError'
  }
}

const NUMBER_FIELDS = [
  'due',
  'stability',
  'difficulty',
  'elapsedDays',
  'scheduledDays',
  'reps',
  'lapses',
  'state',
] as const

/**
 * Validates a value replayed back out of the append-only `reviews` log
 * (`reviews.state_before`) before it is written into live `cards` state.
 * This is the only place that log gets replayed, so a shape drift here
 * (e.g. a newer `ts-fsrs` adding/renaming a field) must throw loudly rather
 * than silently spread stale or extra keys into a row.
 */
export function validateSchedulerState(value: unknown): SchedulerState {
  if (typeof value !== 'object' || value === null) throw new InvalidSchedulerStateError('(root)')
  const v = value as Record<string, unknown>
  for (const field of NUMBER_FIELDS) {
    if (!Number.isFinite(v[field])) throw new InvalidSchedulerStateError(field)
  }
  if (v.lastReview !== null && !Number.isFinite(v.lastReview)) {
    throw new InvalidSchedulerStateError('lastReview')
  }
  return v as unknown as SchedulerState
}
