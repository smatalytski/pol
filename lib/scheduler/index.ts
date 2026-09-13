import { createEmptyCard, fsrs, generatorParameters, Rating, type Card as FsrsCard, type Grade } from 'ts-fsrs'

export const AGAIN = 1 as const
export const HARD = 2 as const
export const GOOD = 3 as const
export const EASY = 4 as const
export type RatingValue = typeof AGAIN | typeof HARD | typeof GOOD | typeof EASY

export type SchedulerState = {
  due: number
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  state: number
  lastReview: number | null
}

const RATING: Record<RatingValue, Grade> = {
  [AGAIN]: Rating.Again,
  [HARD]: Rating.Hard,
  [GOOD]: Rating.Good,
  [EASY]: Rating.Easy,
}

function scheduler(requestRetention = 0.9) {
  return fsrs(generatorParameters({ request_retention: requestRetention }))
}

function toFsrs(s: SchedulerState): FsrsCard {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsedDays,
    scheduled_days: s.scheduledDays,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.lastReview == null ? undefined : new Date(s.lastReview),
  }
}

function fromFsrs(c: FsrsCard): SchedulerState {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.last_review ? new Date(c.last_review).getTime() : null,
  }
}

export function newState(now: Date): SchedulerState {
  return fromFsrs(createEmptyCard(now))
}

export function applyRating(
  state: SchedulerState,
  rating: RatingValue,
  now: Date,
  requestRetention?: number,
): SchedulerState {
  if (state.lastReview !== null && now.getTime() < state.lastReview) {
    throw new Error(
      `applyRating: now (${now.toISOString()}) is before last review (${new Date(state.lastReview).toISOString()})`,
    )
  }
  return fromFsrs(scheduler(requestRetention).next(toFsrs(state), now, RATING[rating]).card)
}
