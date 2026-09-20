import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-zatwierdz-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { captures, generationJobs } = await import('@/lib/db/schema')

const NOW = new Date('2026-09-20T10:00:00')

function seed(id: string, overrides: Partial<typeof captures.$inferInsert> = {}) {
  db.insert(captures)
    .values({
      id,
      audioMediaId: null,
      transcript: 'kot',
      status: 'transcribed',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: NOW.getTime(),
      transcribedAt: NOW.getTime(),
      duplicateOf: null,
      ...overrides,
    })
    .run()
  return id
}

function approve(id: string) {
  return POST(new Request(`http://test/api/captures/${id}/zatwierdz`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(captures).run()
})

describe('POST /api/captures/:id/zatwierdz', () => {
  it('promotes a recording under review and queues its job', async () => {
    seed('c1')
    const res = await approve('c1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.select().from(captures).where(eq(captures.id, 'c1')).get()!.status).toBe('queued')
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('404s for an unknown recording', async () => {
    expect((await approve('nope')).status).toBe(404)
  })

  it('409s for a recording that is not under review, and queues nothing', async () => {
    seed('c1', { status: 'uploaded', transcribedAt: null })
    expect((await approve('c1')).status).toBe(409)
    expect(db.select().from(generationJobs).all()).toHaveLength(0)
  })

  it('409s on the second call, so a double tap makes one card', async () => {
    seed('c1')
    expect((await approve('c1')).status).toBe(200)
    expect((await approve('c1')).status).toBe(409)
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })
})
