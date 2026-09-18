import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-regen-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards, generationJobs } = await import('@/lib/db/schema')
const { newState } = await import('@/lib/scheduler')

const NOW = new Date('2026-09-12T10:00:00')

function seedStranded(id: string) {
  db.insert(cards)
    .values({
      id,
      type: 'ru_to_pl',
      promptText: null,
      promptHint: null,
      answerPl: 'Zdrów jak ryba.',
      answerKey: 'zdrów jak ryba',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'needs_input',
      suspendedAt: null,
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
      ...newState(NOW),
    })
    .run()
  return id
}

function post(id: string) {
  return POST(new Request(`http://test/api/cards/${id}/regeneruj`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  db.delete(generationJobs).run()
  db.delete(cards).run()
})

describe('POST /api/cards/:id/regeneruj', () => {
  it('queues a regenerate job and answers 202 at once', async () => {
    seedStranded('c1')
    const res = await post('c1')
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: true })
    const jobs = db.select().from(generationJobs).all()
    expect(jobs).toEqual([expect.objectContaining({ kind: 'regenerate', cardId: 'c1', status: 'queued' })])
  })

  it('does not queue a second job while one is waiting', async () => {
    seedStranded('c2')
    await post('c2')
    await post('c2')
    expect(db.select().from(generationJobs).all()).toHaveLength(1)
  })

  it('refuses a card that is not needs_input', async () => {
    seedStranded('c3')
    db.update(cards).set({ status: 'ready' }).where(eq(cards.id, 'c3')).run()
    expect((await post('c3')).status).toBe(400)
  })

  it('answers 404 for an unknown card', async () => {
    expect((await post('nope')).status).toBe(404)
  })
})
