import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-captures-id-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { DELETE } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures } = await import('@/lib/db/schema')

const NOW = new Date('2026-09-12T10:00:00')

function seedCapture(overrides: Partial<typeof captures.$inferInsert> & { id: string }) {
  db.insert(captures)
    .values({
      audioMediaId: null,
      transcript: null,
      status: 'uploaded',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: NOW.getTime(),
      ...overrides,
    })
    .run()
  return overrides.id
}

function del(id: string) {
  return DELETE(new Request(`http://test/api/captures/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  db.delete(captures).run()
})

describe('DELETE /api/captures/:id', () => {
  // The core self-review requirement: a capture with no cardId (still
  // uploaded/transcribed/failed — swiping this chip away is the only way to
  // get rid of it, since there is no card yet to soft-delete instead).
  it('removes a capture that has no card yet, without erroring', async () => {
    seedCapture({ id: 'cap-1', status: 'failed', error: 'boom' })
    const res = await del('cap-1')
    expect(res.status).toBe(200)
    expect(db.select().from(captures).where(eq(captures.id, 'cap-1')).get()).toBeUndefined()
  })

  it('is a no-op, not a 404, on an unknown id', async () => {
    const res = await del('ghost')
    expect(res.status).toBe(200)
  })
})
