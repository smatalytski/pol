import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// Same seam as app/api/cards/[id]/audio/route.test.ts: point the real db
// client at a throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-review-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
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

function post(cardId: string, body: unknown) {
  const req = new Request(`http://test/api/review/${cardId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ cardId }) })
}

beforeEach(() => {
  db.delete(cards).run()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/review/:cardId', () => {
  it('accepts a valid rating and schedules the card', async () => {
    seedCard({ id: 'c1' })
    const res = await post('c1', { rating: 3, durationMs: 1200 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.due).toBe('number')
  })

  // ts-fsrs itself throws `Invalid rating:[...]` for anything outside
  // 1-4, but only *after* touching the scheduler — an unvalidated body
  // would surface as a 500 instead of a 400. This is the trust-boundary
  // check the brief calls out explicitly.
  it.each([
    ['zero', 0],
    ['five', 5],
    ['a string', '3'],
    ['a float', 2.5],
    ['undefined', undefined],
    ['null', null],
  ])('rejects rating %s with 400, never reaching the scheduler', async (_label, rating) => {
    seedCard({ id: 'c2' })
    const res = await post('c2', { rating, durationMs: 0 })
    expect(res.status).toBe(400)
    // The card must be untouched — reject before recordReview runs.
    const row = db.select().from(cards).where(eq(cards.id, 'c2')).get()
    expect(row?.reps).toBe(0)
  })

  it('rejects a missing rating with 400', async () => {
    seedCard({ id: 'c3' })
    const res = await post('c3', { durationMs: 0 })
    expect(res.status).toBe(400)
  })

  it('rejects a negative durationMs with 400', async () => {
    seedCard({ id: 'c4' })
    const res = await post('c4', { rating: 3, durationMs: -5 })
    expect(res.status).toBe(400)
  })

  it('accepts a null durationMs', async () => {
    seedCard({ id: 'c5' })
    const res = await post('c5', { rating: 3, durationMs: null })
    expect(res.status).toBe(200)
  })

  // recordReview wraps its two writes in one transaction, and applyRating
  // throws when `now` precedes the card's last review. That throw must
  // propagate uncaught — a 500 is correct for a clock that went backwards,
  // it is not a user input error the route should mask as a 400.
  it('lets a backwards clock propagate rather than swallowing it', async () => {
    seedCard({ id: 'c6', lastReview: NOW.getTime(), state: 2 })
    vi.useFakeTimers({ now: new Date(NOW.getTime() - 60 * 60 * 1000) })
    await expect(post('c6', { rating: 3, durationMs: 0 })).rejects.toThrow(/before last review/)
  })
})
