import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Same seam as app/api/cards/[id]/audio/route.test.ts: point the real db
// client at a throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-cards-id-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { GET, PATCH, DELETE } = await import('./route')
const { POST: restore } = await import('./restore/route')
const { db } = await import('@/lib/db/client')
const { captures, cards, generationJobs, media, reviews, topics } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { newState } = await import('@/lib/scheduler')

const NOW = new Date('2026-09-12T10:00:00')

function seedCard(overrides: Partial<typeof cards.$inferInsert> & { id: string }) {
  db.insert(cards)
    .values({
      type: 'ru_to_pl',
      promptText: 'злобный',
      promptHint: null,
      answerPl: 'złośliwy',
      answerKey: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      suspendedAt: null,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      ...newState(NOW),
      ...overrides,
    })
    .run()
  return overrides.id
}

function get(id: string) {
  return GET(new Request(`http://test/api/cards/${id}`), { params: Promise.resolve({ id }) })
}

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://test/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function del(id: string) {
  return DELETE(new Request(`http://test/api/cards/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
}

function restoreCard(id: string) {
  return restore(new Request(`http://test/api/cards/${id}/restore`, { method: 'POST' }), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  // Order matters: reviews, captures and generationJobs all carry a foreign
  // key to cards, so clearing cards first fails with FOREIGN KEY constraint
  // failed. Media goes last, since captures reference it.
  db.delete(reviews).run()
  db.delete(captures).run()
  db.delete(generationJobs).run()
  db.delete(cards).run()
  db.delete(media).run()
  // Ogólne comes with the migration and stays: new cards are filed under it.
  db.delete(topics).where(eq(topics.isDefault, false)).run()
})

describe('GET /api/cards/:id', () => {
  it('returns the card', async () => {
    seedCard({ id: 'c1' })
    const body = await (await get('c1')).json()
    expect(body.card.answerPl).toBe('złośliwy')
  })

  it('no longer offers a recording to re-recognise', async () => {
    seedCard({ id: 'k1' })
    expect(await (await get('k1')).json()).not.toHaveProperty('captureId')
  })

  it('404s on an unknown id', async () => {
    expect((await get('ghost')).status).toBe(404)
  })

  it('404s on a soft-deleted card, the same as an unknown one', async () => {
    seedCard({ id: 'c2' })
    await del('c2')
    expect((await get('c2')).status).toBe(404)
  })

  it('says generating is true with a queued job for the card', async () => {
    seedCard({ id: 'c8' })
    db.insert(generationJobs)
      .values({
        id: 'job1',
        kind: 'regenerate',
        captureId: null,
        cardId: 'c8',
        status: 'queued',
        attempts: 0,
        failures: 0,
        nextAttemptAt: NOW.getTime(),
        lastError: null,
        createdAt: NOW.getTime(),
        finishedAt: null,
      })
      .run()
    const body = await (await get('c8')).json()
    expect(body.generating).toBe(true)
  })

  it('says generating is false without a job for the card', async () => {
    seedCard({ id: 'c9' })
    const body = await (await get('c9')).json()
    expect(body.generating).toBe(false)
  })

  it('names the card’s topic, or null without one', async () => {
    db.insert(topics).values({ id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1, isDefault: false }).run()
    seedCard({ id: 'k1', topicId: 't1' })
    seedCard({ id: 'k2', answerPl: 'kot', answerKey: 'kot' })
    expect((await (await get('k1')).json()).topic).toEqual({ id: 't1', name: 'U lekarza' })
    expect((await (await get('k2')).json()).topic).toBeNull()
  })
})

describe('PATCH /api/cards/:id', () => {
  it('edits fields and recomputes the answer key', async () => {
    seedCard({ id: 'c3' })
    const res = await patch('c3', { answerPl: 'wredny' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card.answerPl).toBe('wredny')
    expect(body.card.answerKey).toBe('wredny')
  })

  it('rejects a bad patch body', async () => {
    seedCard({ id: 'c4' })
    const res = await patch('c4', { answerPl: '' })
    expect(res.status).toBe(400)
  })

  it('rejects an unexpected field type instead of coercing it', async () => {
    seedCard({ id: 'c5' })
    const res = await patch('c5', { suspendedAt: 'not-a-number' })
    expect(res.status).toBe(400)
  })

  // Important review finding: updateCard's own lookup lacked the deleted_at
  // filter, so PATCHing a deleted card's id silently succeeded and wrote
  // fields to an invisible row. Fixed in lib/cards/service.ts; this pins the
  // route-level behavior (an unhandled throw, same as every other "no such
  // card" error path in this codebase — see app/api/review/[cardId]/route.ts,
  // which has the same no-catch convention).
  it('does not silently succeed when PATCHing a soft-deleted card', async () => {
    seedCard({ id: 'c7' })
    await del('c7')
    await expect(patch('c7', { answerPl: 'x' })).rejects.toThrow(/no such card/)
  })

  it('moves a card to another topic via topicId', async () => {
    db.insert(topics).values({ id: 't1', name: 'U lekarza', context: 'x', suspendedAt: null, createdAt: 1, isDefault: false }).run()
    seedCard({ id: 'c10' })
    const res = await patch('c10', { topicId: 't1' })
    expect(res.status).toBe(200)
    expect((await res.json()).card).toMatchObject({ topicId: 't1' })
  })

  it('is 404 when moving to an unknown topic', async () => {
    seedCard({ id: 'c11' })
    const res = await patch('c11', { topicId: 'nope' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/cards/:id/restore', () => {
  it('undeletes a card', async () => {
    seedCard({ id: 'c12' })
    await del('c12')
    const res = await restoreCard('c12')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card).toMatchObject({ id: 'c12', deletedAt: null })
  })

  it('is 404 for an unknown or non-deleted card', async () => {
    seedCard({ id: 'c13' })
    expect((await restoreCard('c13')).status).toBe(404)
    expect((await restoreCard('ghost')).status).toBe(404)
  })

  it('refuses with 409 when a live card now owns the same answer key and type', async () => {
    seedCard({ id: 'c14', answerPl: 'złośliwy', answerKey: 'złośliwy' })
    await del('c14')
    db.insert(topics).values({ id: 't2', name: 'U mechanika', context: 'x', suspendedAt: null, createdAt: 1, isDefault: false }).run()
    seedCard({ id: 'c15', answerPl: 'złośliwy', answerKey: 'złośliwy', topicId: 't2' })
    const res = await restoreCard('c14')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'już masz — w temacie U mechanika' })
  })
})

describe('DELETE /api/cards/:id', () => {
  it('soft-deletes: the card and its reviews survive, but it disappears from the search route', async () => {
    seedCard({ id: 'c6' })
    db.insert(reviews)
      .values({ cardId: 'c6', rating: 3, reviewedAt: NOW.getTime(), durationMs: null, stateBefore: '{}', undoneAt: null })
      .run()
    const res = await del('c6')
    expect(res.status).toBe(200)
    const row = db.select().from(cards).get()!
    expect(row.deletedAt).not.toBeNull()
    expect(db.select().from(reviews).all()).toHaveLength(1)
  })

  it('is a no-op, not an error, on an unknown id', async () => {
    expect((await del('ghost')).status).toBe(200)
  })
})
