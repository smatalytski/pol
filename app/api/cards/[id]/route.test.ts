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
const { db } = await import('@/lib/db/client')
const { captures, cards, media, reviews } = await import('@/lib/db/schema')
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

beforeEach(() => {
  // Order matters: reviews and captures both carry a foreign key to cards, so
  // clearing cards first fails with FOREIGN KEY constraint failed. Media goes
  // last, since captures reference it.
  db.delete(reviews).run()
  db.delete(captures).run()
  db.delete(cards).run()
  db.delete(media).run()
})

describe('GET /api/cards/:id', () => {
  it('returns the card', async () => {
    seedCard({ id: 'c1' })
    const body = await (await get('c1')).json()
    expect(body.card.answerPl).toBe('złośliwy')
  })

  // The detail screen offers "re-recognise this recording in Russian" only
  // when there is a recording to re-recognise, so it needs to know. Dedup
  // means several captures can point at one card (a duplicate dictation
  // resolves to the card it matched), so this is the capture that CREATED the
  // card — the earliest — not whichever one most recently pointed at it.
  // Re-recognising a later duplicate's audio would rewrite a card that
  // recording never made.
  it('returns the id of the capture that created the card', async () => {
    seedCard({ id: 'with-audio' })
    const mediaId = 'm1'
    db.insert(media).values({ id: mediaId, kind: 'audio', mime: 'audio/webm', bytes: Buffer.from([1]), byteSize: 1, createdAt: 1 }).run()
    db.insert(captures).values({ id: 'first', audioMediaId: mediaId, transcript: 'x', status: 'generated', error: null, generationJson: null, cardId: 'with-audio', createdAt: 100 }).run()
    db.insert(captures).values({ id: 'later-duplicate', audioMediaId: mediaId, transcript: 'x', status: 'generated', error: null, generationJson: null, cardId: 'with-audio', createdAt: 200 }).run()

    const body = await (await GET(new Request('http://test'), { params: Promise.resolve({ id: 'with-audio' }) })).json()
    expect(body.captureId).toBe('first')
  })

  it('returns no capture id for a card that was never dictated', async () => {
    seedCard({ id: 'typed' })
    const body = await (await GET(new Request('http://test'), { params: Promise.resolve({ id: 'typed' }) })).json()
    expect(body.captureId).toBeNull()
  })

  it('404s on an unknown id', async () => {
    expect((await get('ghost')).status).toBe(404)
  })

  it('404s on a soft-deleted card, the same as an unknown one', async () => {
    seedCard({ id: 'c2' })
    await del('c2')
    expect((await get('c2')).status).toBe(404)
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
