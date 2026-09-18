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
const { captures, cards } = await import('@/lib/db/schema')
const { createCard } = await import('@/lib/cards/service')

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
  db.delete(cards).run()
})

describe('DELETE /api/captures/:id', () => {
  // The core self-review requirement: a capture with no cardId (still
  // uploaded/transcribed/failed — swiping this chip away is the only way to
  // get rid of it, since there is no card yet to soft-delete instead).
  // B3 (test-integrity finding): seeding only one row meant a lost `WHERE`
  // on this table-wide `db.delete(captures)` — wiping every in-flight
  // capture, not just the one requested — would leave this test green.
  // Seeding a second row and asserting it survives closes that gap.
  it('removes only the requested capture, leaving other in-flight captures untouched', async () => {
    seedCapture({ id: 'cap-1', status: 'failed', error: 'boom' })
    seedCapture({ id: 'cap-2', status: 'uploaded' })
    const res = await del('cap-1')
    expect(res.status).toBe(200)
    expect(db.select().from(captures).where(eq(captures.id, 'cap-1')).get()).toBeUndefined()
    expect(db.select().from(captures).where(eq(captures.id, 'cap-2')).get()).toBeDefined()
  })

  // Spec §8: only a recording with no card is rejected here. One that became
  // a card is part of that card's history (its audio is kept, per spec §4),
  // and a card is deleted from the card screen instead.
  it('refuses a recording that has a card, with 409, and keeps it', async () => {
    const { cardId } = createCard(
      db,
      {
        type: 'ru_to_pl', promptText: 'кот', promptHint: null, answerPl: 'kot', examplePl: null, exampleRu: null,
        grammarNote: null, wordKind: null, formsJson: null, status: 'ready',
      },
      NOW,
    )
    seedCapture({ id: 'cap-1', status: 'generated', cardId, transcript: 'kot' })
    const res = await del('cap-1')
    expect(res.status).toBe(409)
    expect(db.select().from(captures).where(eq(captures.id, 'cap-1')).get()).toBeDefined()
  })

  it('is a no-op, not a 404, on an unknown id', async () => {
    const res = await del('ghost')
    expect(res.status).toBe(200)
  })
})
