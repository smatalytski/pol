import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-settings-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { GET, PUT } = await import('./route')
const { db } = await import('@/lib/db/client')
const { settings } = await import('@/lib/db/schema')

beforeEach(() => {
  db.delete(settings).run()
})

function put(body: unknown) {
  return PUT(
    new Request('http://test/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('GET /api/settings', () => {
  it('returns the defaults on an empty table', async () => {
    const body = await (await GET()).json()
    expect(body).toEqual({ newPerDay: 10, requestRetention: 0.9, audioGapSeconds: 5 })
  })
})

describe('PUT /api/settings', () => {
  it('writes a legitimate override and returns the updated settings', async () => {
    const res = await put({ newPerDay: 25 })
    expect(res.status).toBe(200)
    expect((await res.json()).newPerDay).toBe(25)
  })

  // The real finding this guards: ts-fsrs treats a falsy request_retention
  // (0) as "unset" and silently substitutes its own 0.9 default. A route that
  // let 0 through as "valid" would look like it worked while quietly
  // scheduling everyone at the wrong retention target.
  it('rejects requestRetention of 0 instead of writing it through to be silently coerced downstream', async () => {
    const res = await put({ requestRetention: 0 })
    expect(res.status).toBe(400)
    // Not written at all, not just clamped — getSettings() has no idea a PUT was attempted.
    expect((await (await GET()).json()).requestRetention).toBe(0.9)
  })

  it('rejects a requestRetention above 0.98', async () => {
    const res = await put({ requestRetention: 0.99 })
    expect(res.status).toBe(400)
  })

  it('rejects a negative or non-integer newPerDay', async () => {
    expect((await put({ newPerDay: -1 })).status).toBe(400)
    expect((await put({ newPerDay: 2.5 })).status).toBe(400)
  })
})
