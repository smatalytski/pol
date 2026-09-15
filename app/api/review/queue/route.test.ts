import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Same seam as app/api/review/[cardId]/route.test.ts: point the real db
// client at a throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-review-queue-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { GET } = await import('./route')
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
      promptMediaId: null,
      answerPl: 'złośliwy',
      answerKey: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      parentCardId: null,
      suspendedAt: null,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      ...newState(NOW),
      ...overrides,
    })
    .run()
  return overrides.id
}

beforeEach(() => {
  db.delete(cards).run()
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/review/queue', () => {
  it('returns an empty queue and no next-due time when there are no cards at all', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ cards: [], nextDue: null })
  })

  it('interleaves due and new cards, per buildQueue', async () => {
    // Two due (state != 0, due <= now) cards and one never-introduced
    // (state 0) card. Stride is max(2, floor(2/1)) = 2, so the new card
    // lands after the second due card — this also pins the route's wiring
    // to buildQueue's actual ordering, not just "some array of 3."
    seedCard({ id: 'due-1', due: NOW.getTime() - 60_000, state: 2, reps: 1, lastReview: NOW.getTime() - 86_400_000 })
    seedCard({ id: 'due-2', due: NOW.getTime() - 30_000, state: 2, reps: 1, lastReview: NOW.getTime() - 86_400_000 })
    seedCard({ id: 'new-1', state: 0 })

    const res = await GET()
    const body = await res.json()
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual(['due-1', 'due-2', 'new-1'])
    expect(body.cards.map((c: { isNew: boolean }) => c.isNew)).toEqual([false, false, true])
    expect(body.nextDue).toBeNull()
  })

  it('reports nextDue when nothing is due yet but a future card exists', async () => {
    const future = NOW.getTime() + 3 * 24 * 60 * 60 * 1000
    seedCard({ id: 'future-1', due: future, state: 2, reps: 1, lastReview: NOW.getTime() - 86_400_000 })

    const res = await GET()
    const body = await res.json()
    expect(body.cards).toEqual([])
    expect(body.nextDue).toBe(future)
  })

  it('does not let a suspended future card set nextDue', async () => {
    const future = NOW.getTime() + 3 * 24 * 60 * 60 * 1000
    seedCard({
      id: 'suspended-1',
      due: future,
      state: 2,
      reps: 1,
      lastReview: NOW.getTime() - 86_400_000,
      suspendedAt: NOW.getTime(),
    })

    const res = await GET()
    const body = await res.json()
    expect(body.nextDue).toBeNull()
  })
})
