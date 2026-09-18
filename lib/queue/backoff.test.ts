import { describe, expect, it } from 'vitest'
import { BACKOFF_CAP_MS, backoffMs } from './backoff'

describe('backoffMs', () => {
  it('starts between 2.5 s and 5 s', () => {
    expect(backoffMs(1, () => 0)).toBe(2_500)
    expect(backoffMs(1, () => 1)).toBe(5_000)
  })

  it('doubles with each attempt', () => {
    expect(backoffMs(2, () => 1)).toBe(10_000)
    expect(backoffMs(3, () => 1)).toBe(20_000)
  })

  it('never exceeds 5 minutes', () => {
    expect(backoffMs(30, () => 1)).toBe(BACKOFF_CAP_MS)
    expect(backoffMs(30, () => 0)).toBe(BACKOFF_CAP_MS / 2)
  })
})
