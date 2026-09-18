/**
 * The review window (spec 2026-09-18-generation-queue §3). Pure: no database,
 * no clock, so the list endpoint and the worker share one definition of
 * "approved" and it can be tested at its exact edges.
 */

export const REVIEW_MS = 10_000
export const MAX_IN_REVIEW = 5

export type ReviewRow = { id: string; transcribedAt: number; createdAt: number }

/** Newest first — the order the recording screen shows, and the order the "only the 5 newest stay" rule counts in. */
function newestFirst(a: ReviewRow, b: ReviewRow): number {
  return b.transcribedAt - a.transcribedAt || b.createdAt - a.createdAt
}

/**
 * Which recordings under review are approved at `now`: those 10 s past their
 * transcript, and every one beyond the 5 newest. Rows past 10 s are always the
 * oldest, so "5 newest of all" and "5 newest still under review" pick the same
 * rows.
 */
export function approvedIds(underReview: readonly ReviewRow[], now: number): Set<string> {
  const approved = new Set<string>()
  ;[...underReview].sort(newestFirst).forEach((row, i) => {
    if (i >= MAX_IN_REVIEW || now - row.transcribedAt >= REVIEW_MS) approved.add(row.id)
  })
  return approved
}

export function reviewRemainingMs(row: ReviewRow, now: number): number {
  return Math.max(0, row.transcribedAt + REVIEW_MS - now)
}
