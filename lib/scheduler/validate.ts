import type { SchedulerState } from './index'

export class InvalidSchedulerStateError extends Error {
  constructor(field: string) {
    super(`invalid scheduler state: ${field}`)
    this.name = 'InvalidSchedulerStateError'
  }
}

// `satisfies`, not a `: readonly (keyof SchedulerState)[]` annotation: an
// explicit annotation would widen `typeof NUMBER_FIELDS` to that same broad
// array type, which would make `MissingNumberField` below vacuously `never`
// no matter what the list actually contains. `satisfies` checks membership
// without discarding the literal tuple type `as const` gives it, which the
// exhaustiveness check depends on.
export const NUMBER_FIELDS = [
  'due',
  'stability',
  'difficulty',
  'elapsedDays',
  'scheduledDays',
  'reps',
  'lapses',
  'state',
] as const satisfies readonly (keyof SchedulerState)[]

// Exhaustiveness check (unnamed-invariant finding, A5): every SchedulerState
// field except the nullable `lastReview` (validated separately below) must
// appear in NUMBER_FIELDS. TypeScript does not apply excess-property checks
// to this kind of list, so nothing else stops a field added to
// SchedulerState — e.g. by a ts-fsrs upgrade — from silently missing its
// validation here. If that happens, `MissingNumberField` stops being
// `never`, and the assignment below fails to typecheck.
type MissingNumberField = Exclude<Exclude<keyof SchedulerState, 'lastReview'>, (typeof NUMBER_FIELDS)[number]>
export const assertNoMissingNumberFields: MissingNumberField extends never ? true : never = true

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
