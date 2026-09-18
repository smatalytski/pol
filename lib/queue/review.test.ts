import { describe, expect, it } from 'vitest'
import { MAX_IN_REVIEW, REVIEW_MS, approvedIds, reviewRemainingMs, type ReviewRow } from './review'

const row = (id: string, transcribedAt: number, createdAt = transcribedAt): ReviewRow => ({ id, transcribedAt, createdAt })

describe('approvedIds', () => {
  it('keeps a recording under review until exactly 10 000 ms have passed', () => {
    expect(approvedIds([row('a', 1_000)], 1_000 + REVIEW_MS - 1).has('a')).toBe(false)
    expect(approvedIds([row('a', 1_000)], 1_000 + REVIEW_MS).has('a')).toBe(true)
  })

  it('approves the oldest once more than 5 are under review', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(`r${n}`, 1_000 + n))
    const approved = approvedIds(rows, 1_010)
    expect([...approved]).toEqual(['r1'])
    expect(MAX_IN_REVIEW).toBe(5)
  })

  it('keeps exactly 5 under review when there are 5', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(`r${n}`, 1_000 + n))
    expect(approvedIds(rows, 1_010).size).toBe(0)
  })

  // Two recordings transcribed in the same millisecond still have a stable
  // order: the one uploaded later counts as newer.
  it('breaks a transcription-time tie by upload time', () => {
    const rows = [
      row('newer', 2_000, 20), row('older', 2_000, 10),
      row('a', 2_001), row('b', 2_002), row('c', 2_003), row('d', 2_004),
    ]
    expect([...approvedIds(rows, 2_005)]).toEqual(['older'])
  })

  it('does not mutate its input', () => {
    const rows = [row('b', 2), row('a', 1)]
    approvedIds(rows, 3)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('reviewRemainingMs', () => {
  it('counts down to zero and never below', () => {
    expect(reviewRemainingMs(row('a', 1_000), 1_000)).toBe(REVIEW_MS)
    expect(reviewRemainingMs(row('a', 1_000), 7_000)).toBe(4_000)
    expect(reviewRemainingMs(row('a', 1_000), 99_000)).toBe(0)
  })
})
