import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-login-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
process.env.APP_PASSWORD = 'correct-horse'
process.env.SESSION_SECRET = 'test-secret'
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { loginThrottle } = await import('@/lib/db/schema')
const { FREE_ATTEMPTS, BASE_DELAY_MS } = await import('@/lib/auth/throttle')

function login(password: string) {
  return POST(
    new Request('http://test/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  )
}

const state = () => db.select().from(loginThrottle).where(eq(loginThrottle.id, 1)).get()!

function setState(failures: number, blockedUntil: number | null) {
  db.update(loginThrottle).set({ failures, blockedUntil }).where(eq(loginThrottle.id, 1)).run()
}

beforeEach(() => setState(0, null))

describe('POST /api/login', () => {
  it('lets the right password in and hands back a session cookie', async () => {
    const res = await login('correct-horse')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('fiszki_session=')
  })

  it('refuses a wrong password and counts it', async () => {
    expect((await login('nope')).status).toBe(401)
    expect(state().failures).toBe(1)
    expect(state().blockedUntil).toBeNull()
  })

  it('tolerates typos up to the free allowance without blocking', async () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await login('nope')).status).toBe(401)
    expect(state().blockedUntil).toBeNull()
    // The right password still works — an ordinary fat-fingered login is not punished.
    expect((await login('correct-horse')).status).toBe(200)
  })

  it('blocks with 429 and a Retry-After once the allowance is spent', async () => {
    for (let i = 0; i <= FREE_ATTEMPTS; i++) await login('nope')
    const res = await login('nope')
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(BASE_DELAY_MS / 1000 * 2)
  })

  it('refuses even the CORRECT password while blocked, and issues no cookie', async () => {
    // The whole point of the gate: otherwise an attacker who guesses right on
    // attempt 400 walks in regardless of the throttle.
    setState(FREE_ATTEMPTS + 1, Date.now() + BASE_DELAY_MS)
    const res = await login('correct-horse')
    expect(res.status).toBe(429)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('does not extend the block for an attempt it already refused', async () => {
    const blockedUntil = Date.now() + BASE_DELAY_MS
    setState(FREE_ATTEMPTS + 1, blockedUntil)
    await login('nope')
    expect(state().failures).toBe(FREE_ATTEMPTS + 1)
    expect(state().blockedUntil).toBe(blockedUntil)
  })

  it('lets the owner back in once the block expires, and clears the budget', async () => {
    setState(FREE_ATTEMPTS + 3, Date.now() - 1)
    const res = await login('correct-horse')
    expect(res.status).toBe(200)
    expect(state()).toMatchObject({ failures: 0, blockedUntil: null })
  })

  it('survives a restart — the counter is in the database, not in memory', async () => {
    await login('nope')
    const { POST: reimported } = await import('./route')
    await reimported(
      new Request('http://test/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'nope' }),
      }),
    )
    expect(state().failures).toBe(2)
  })
})
