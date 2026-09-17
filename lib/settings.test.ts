import { describe, expect, it } from 'vitest'
import { createTestDb } from './db/testing'
import { getSettings, setSetting } from './settings'

describe('settings', () => {
  it('returns defaults on an empty table', () => {
    const { db } = createTestDb()
    expect(getSettings(db)).toEqual({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 })
  })

  it('reads back an override, coerced to a number', () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', '25')
    expect(getSettings(db).newPerDay).toBe(25)
  })

  it('ignores a corrupt value rather than returning NaN', () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', 'banana')
    expect(getSettings(db).newPerDay).toBe(10)
  })

  it('overwrites rather than duplicating a key', () => {
    const { db } = createTestDb()
    setSetting(db, 'newPerDay', '5')
    setSetting(db, 'newPerDay', '7')
    expect(getSettings(db).newPerDay).toBe(7)
  })

  it('falls back to the default when requestRetention is out of its valid range', () => {
    const { db } = createTestDb()
    for (const bad of ['0', '1.5', '-0.5']) {
      setSetting(db, 'requestRetention', bad)
      expect(getSettings(db).requestRetention).toBe(0.9)
    }
  })

  it('honours a legitimate requestRetention override', () => {
    const { db } = createTestDb()
    setSetting(db, 'requestRetention', '0.85')
    expect(getSettings(db).requestRetention).toBe(0.85)
  })

  it('falls back to the default when newPerDay is negative or non-integer', () => {
    const { db } = createTestDb()
    for (const bad of ['-1', '1.5']) {
      setSetting(db, 'newPerDay', bad)
      expect(getSettings(db).newPerDay).toBe(10)
    }
  })

  it('falls back to the default when audioGapSeconds is negative', () => {
    const { db } = createTestDb()
    setSetting(db, 'audioGapSeconds', '-1')
    expect(getSettings(db).audioGapSeconds).toBe(5)
  })
})
