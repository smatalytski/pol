import { describe, expect, it } from 'vitest'
import { AGAIN, EASY, GOOD, HARD, applyRating, newState } from './index'

const T0 = new Date('2026-09-12T08:00:00Z')
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000)

describe('scheduler', () => {
  it('a new card is due immediately and unseen', () => {
    const s = newState(T0)
    expect(s.reps).toBe(0)
    expect(s.lapses).toBe(0)
    expect(s.state).toBe(0)
    expect(s.lastReview).toBeNull()
    expect(s.due).toBe(T0.getTime())
  })

  it('records the review time and increments reps', () => {
    const s = applyRating(newState(T0), GOOD, T0)
    expect(s.reps).toBe(1)
    expect(s.lastReview).toBe(T0.getTime())
  })

  it('orders intervals Again < Hard < Good < Easy from the same state', () => {
    const base = applyRating(applyRating(newState(T0), GOOD, T0), GOOD, days(1))
    const at = days(5)
    const due = ([AGAIN, HARD, GOOD, EASY] as const).map((r) => applyRating(base, r, at).due)
    expect(due[0]).toBeLessThan(due[1])
    expect(due[1]).toBeLessThan(due[2])
    expect(due[2]).toBeLessThan(due[3])
  })

  it('counts a lapse only on Again, and only from a reviewing state', () => {
    const reviewing = applyRating(applyRating(newState(T0), EASY, T0), GOOD, days(3))
    expect(applyRating(reviewing, AGAIN, days(10)).lapses).toBeGreaterThan(reviewing.lapses)
    expect(applyRating(reviewing, GOOD, days(10)).lapses).toBe(reviewing.lapses)
  })

  it('pushes a well-known card weeks out, not hours', () => {
    let s = newState(T0)
    s = applyRating(s, EASY, T0)
    s = applyRating(s, EASY, days(3))
    s = applyRating(s, EASY, days(20))
    expect(s.due - days(20).getTime()).toBeGreaterThan(14 * 86_400_000)
  })

  // B4 (test-integrity finding): `s` is already flat primitives, so
  // `{ ...s }` crosses no real boundary — the original assertion would pass
  // even with serialization completely broken (it never calls JSON at all).
  // Route it through JSON.stringify/parse instead — the actual boundary
  // `reviews.state_before` crosses in lib/review/service.ts — so a value
  // that doesn't survive that boundary losslessly (e.g. NaN/Infinity
  // silently becoming `null`) is caught directly, and a further rating
  // applied on the revived state still produces the same result as one
  // applied on the original.
  it('round-trips through JSON.stringify/parse without loss', () => {
    const s = applyRating(newState(T0), HARD, T0)
    const revived = JSON.parse(JSON.stringify(s))
    expect(revived).toEqual(s)
    expect(applyRating(revived, GOOD, days(1))).toEqual(applyRating(s, GOOD, days(1)))
  })

  it('throws if now is before the last review, instead of producing NaN state', () => {
    const s = applyRating(newState(T0), GOOD, T0)
    expect(() => applyRating(s, GOOD, days(-2))).toThrow(/now.*before.*last review/i)
  })
})
