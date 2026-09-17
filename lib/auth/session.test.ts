import { describe, expect, it } from 'vitest'
import { constantTimeEqual, createSessionToken, verifySessionToken } from './session'

const SECRET = 'a'.repeat(64)
const NOW = new Date('2026-09-12T10:00:00Z')

describe('session token', () => {
  it('verifies a token it just issued', async () => {
    const token = await createSessionToken(SECRET, NOW)
    expect(await verifySessionToken(SECRET, token, NOW)).toBe(true)
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await createSessionToken(SECRET, NOW)
    expect(await verifySessionToken('b'.repeat(64), token, NOW)).toBe(false)
  })

  it('rejects a tampered expiry', async () => {
    const token = await createSessionToken(SECRET, NOW, 1000)
    const [, sig] = token.split('.')
    const forged = `${NOW.getTime() + 9_999_999}.${sig}`
    expect(await verifySessionToken(SECRET, forged, NOW)).toBe(false)
  })

  it('rejects an expired token', async () => {
    const token = await createSessionToken(SECRET, NOW, 1000)
    expect(await verifySessionToken(SECRET, token, new Date(NOW.getTime() + 2000))).toBe(false)
  })

  it('rejects garbage without throwing', async () => {
    for (const bad of ['', '.', 'abc', 'abc.def', '123.', '1e999.x']) {
      expect(await verifySessionToken(SECRET, bad, NOW)).toBe(false)
    }
  })
})

describe('constantTimeEqual', () => {
  it('compares equal strings as equal', () => {
    expect(constantTimeEqual('hasło', 'hasło')).toBe(true)
  })

  it('rejects different strings, including different lengths', () => {
    expect(constantTimeEqual('hasło', 'haslo')).toBe(false)
    expect(constantTimeEqual('hasło', 'hasłoo')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
  })
})
