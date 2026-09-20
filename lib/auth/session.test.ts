import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MS, IDLE_MS, constantTimeEqual, createSessionToken, mintSessionToken,
  readSessionToken, renewSessionToken, shouldRenew, verifySessionToken,
} from './session'

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

describe('idle window and absolute cap', () => {
  it('issues a token that carries when it was issued, not only when it expires', async () => {
    const token = await createSessionToken(SECRET, NOW)
    expect(token.split('.')).toHaveLength(3)
    const claims = await readSessionToken(SECRET, token, NOW)
    expect(claims).toEqual({ issuedAt: NOW.getTime(), expiresAt: NOW.getTime() + IDLE_MS })
  })

  it('rejects a token idle past the window even though the cap is far off', async () => {
    const token = await createSessionToken(SECRET, NOW)
    const later = new Date(NOW.getTime() + IDLE_MS + 1)
    expect(await readSessionToken(SECRET, token, later)).toBeNull()
  })

  it('rejects a token past the absolute cap however recently it was renewed', async () => {
    // A renewed token: issued a year ago, idle expiry still in the future.
    const issuedAt = NOW.getTime() - ABSOLUTE_MS - 1
    const token = await mintSessionToken(SECRET, issuedAt, NOW.getTime() + IDLE_MS)
    expect(await readSessionToken(SECRET, token, NOW)).toBeNull()
  })

  it('rejects a forged issuedAt, so the cap cannot be pushed out', async () => {
    const token = await createSessionToken(SECRET, NOW)
    const [, expiresAt, sig] = token.split('.')
    const forged = `${NOW.getTime() + 999_999}.${expiresAt}.${sig}`
    expect(await readSessionToken(SECRET, forged, NOW)).toBeNull()
  })

  it('rejects an old two-part token, so the format change cannot be replayed', async () => {
    const expiresAt = String(NOW.getTime() + IDLE_MS)
    const forged = `${expiresAt}.${(await createSessionToken(SECRET, NOW)).split('.')[2]}`
    expect(await readSessionToken(SECRET, forged, NOW)).toBeNull()
  })
})

describe('renewal', () => {
  const fresh = { issuedAt: NOW.getTime(), expiresAt: NOW.getTime() + IDLE_MS }

  it('does not renew a session that has barely been used', () => {
    expect(shouldRenew(fresh, NOW.getTime() + 1000)).toBe(false)
  })

  it('renews once more than half the idle window has been consumed', () => {
    expect(shouldRenew(fresh, NOW.getTime() + IDLE_MS / 2 + 1)).toBe(true)
  })

  it('stops renewing at the absolute cap, so daily use still re-authenticates eventually', () => {
    const old = { issuedAt: NOW.getTime() - ABSOLUTE_MS, expiresAt: NOW.getTime() + 1000 }
    expect(shouldRenew(old, NOW.getTime())).toBe(false)
  })

  it('renews without moving issuedAt, and never past the cap', async () => {
    const issuedAt = NOW.getTime() - (ABSOLUTE_MS - 1000)
    const now = NOW.getTime()
    const token = await renewSessionToken(SECRET, { issuedAt, expiresAt: now + 1 }, now)
    const claims = (await readSessionToken(SECRET, token, now))!
    expect(claims.issuedAt).toBe(issuedAt)
    expect(claims.expiresAt).toBe(issuedAt + ABSOLUTE_MS)
  })
})
