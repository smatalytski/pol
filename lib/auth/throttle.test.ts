import { describe, expect, it } from 'vitest'
import {
  BASE_DELAY_MS, FREE_ATTEMPTS, MAX_DELAY_MS,
  afterFailure, afterSuccess, penaltyMs, retryAfterMs, type ThrottleState,
} from './throttle'

const T = 1_000_000
const fresh: ThrottleState = { failures: 0, blockedUntil: null }

describe('penaltyMs', () => {
  it('costs nothing while inside the free allowance', () => {
    for (let n = 0; n <= FREE_ATTEMPTS; n++) expect(penaltyMs(n)).toBe(0)
  })

  it('doubles from the base delay once the allowance is spent', () => {
    expect(penaltyMs(FREE_ATTEMPTS + 1)).toBe(BASE_DELAY_MS)
    expect(penaltyMs(FREE_ATTEMPTS + 2)).toBe(BASE_DELAY_MS * 2)
    expect(penaltyMs(FREE_ATTEMPTS + 3)).toBe(BASE_DELAY_MS * 4)
  })

  it('caps, so a determined attacker cannot lock the owner out indefinitely', () => {
    expect(penaltyMs(FREE_ATTEMPTS + 99)).toBe(MAX_DELAY_MS)
  })
})

describe('retryAfterMs', () => {
  it('lets an untouched state through', () => {
    expect(retryAfterMs(fresh, T)).toBeNull()
  })

  it('reports what is left of the block', () => {
    expect(retryAfterMs({ failures: 6, blockedUntil: T + 30_000 }, T)).toBe(30_000)
  })

  it('lets the attempt through the instant the block expires', () => {
    expect(retryAfterMs({ failures: 6, blockedUntil: T }, T)).toBeNull()
    expect(retryAfterMs({ failures: 6, blockedUntil: T - 1 }, T)).toBeNull()
  })
})

describe('afterFailure', () => {
  it('counts a failure without blocking while inside the allowance', () => {
    expect(afterFailure(fresh, T)).toEqual({ failures: 1, blockedUntil: null })
  })

  it('starts blocking on the failure after the allowance', () => {
    const state = { failures: FREE_ATTEMPTS, blockedUntil: null }
    expect(afterFailure(state, T)).toEqual({
      failures: FREE_ATTEMPTS + 1,
      blockedUntil: T + BASE_DELAY_MS,
    })
  })

  it('lengthens the block as failures accumulate', () => {
    const state = { failures: FREE_ATTEMPTS + 1, blockedUntil: T }
    expect(afterFailure(state, T).blockedUntil).toBe(T + BASE_DELAY_MS * 2)
  })
})

describe('afterSuccess', () => {
  it('clears everything, so a real login resets the budget', () => {
    expect(afterSuccess()).toEqual({ failures: 0, blockedUntil: null })
  })
})
