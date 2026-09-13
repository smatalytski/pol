import { describe, expect, it } from 'vitest'
import { createTestDb } from '../db/testing'
import { getMedia, putMedia } from './store'

describe('media store', () => {
  it('round-trips bytes unchanged', () => {
    const { db } = createTestDb()
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const id = putMedia(db, { kind: 'audio', mime: 'audio/webm', bytes })
    const got = getMedia(db, id)
    expect(got?.mime).toBe('audio/webm')
    expect(got?.byteSize).toBe(6)
    expect([...(got!.bytes)]).toEqual([0, 1, 2, 253, 254, 255])
  })

  it('honours a caller-supplied id', () => {
    const { db } = createTestDb()
    const id = putMedia(db, { kind: 'tts', mime: 'audio/mpeg', bytes: new Uint8Array([1]), id: 'fixed' })
    expect(id).toBe('fixed')
    expect(getMedia(db, 'fixed')).not.toBeNull()
  })

  it('returns null for an unknown id', () => {
    const { db } = createTestDb()
    expect(getMedia(db, 'nope')).toBeNull()
  })
})
