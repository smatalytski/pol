import type { QueueItem } from '@/lib/review/queue'

export type ReviewState = {
  queue: QueueItem[]
  revealed: boolean
  lastRated: QueueItem | null
}

export type ReviewAction =
  | { type: 'loaded'; queue: QueueItem[] }
  | { type: 'reveal' }
  | { type: 'rate' }
  | { type: 'undo' }

export const initialReviewState: ReviewState = { queue: [], revealed: false, lastRated: null }

export function currentCard(state: ReviewState): QueueItem | null {
  return state.queue[0] ?? null
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'loaded':
      return { queue: action.queue, revealed: false, lastRated: null }
    case 'reveal':
      return state.queue.length === 0 ? state : { ...state, revealed: true }
    case 'rate':
      return state.queue.length === 0
        ? state
        : { queue: state.queue.slice(1), revealed: false, lastRated: state.queue[0] }
    case 'undo':
      return state.lastRated === null
        ? state
        : { queue: [state.lastRated, ...state.queue], revealed: false, lastRated: null }
  }
}
