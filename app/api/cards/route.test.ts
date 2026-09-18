import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Same seam as app/api/cards/[id]/audio/route.test.ts: point the real db
// client at a throwaway file before anything imports it.
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-cards-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { GET, POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { deleteCard } = await import('@/lib/cards/service')

beforeEach(() => {
  db.delete(cards).run()
})

function get(q?: string) {
  return GET(new Request(`http://test/api/cards${q !== undefined ? `?q=${encodeURIComponent(q)}` : ''}`))
}

function post(body: unknown) {
  return POST(
    new Request('http://test/api/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('GET /api/cards', () => {
  it('creates and lists a card via a full round trip', async () => {
    await post({ type: 'ru_to_pl', promptText: 'привет', promptHint: null, answerPl: 'cześć' })
    const res = await get('')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0].answerPl).toBe('cześć')
  })

  it('excludes a soft-deleted card from the list', async () => {
    const created = await (await post({ type: 'ru_to_pl', promptText: null, promptHint: null, answerPl: 'cześć' })).json()
    deleteCard(db, created.cardId, new Date())
    const body = await (await get('')).json()
    expect(body.cards).toEqual([])
  })
})

describe('POST /api/cards', () => {
  it('rejects a body missing a required field', async () => {
    const res = await post({ type: 'ru_to_pl', promptText: null, promptHint: null })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown card type', async () => {
    const res = await post({ type: 'bogus', promptText: null, promptHint: null, answerPl: 'x' })
    expect(res.status).toBe(400)
  })

  // pl_forms cards are removed (spec §9): nothing may create one any more.
  it('rejects a pl_forms card', async () => {
    const res = await post({ type: 'pl_forms', promptText: null, promptHint: null, answerPl: 'x' })
    expect(res.status).toBe(400)
  })

  it('deduplicates a manually-created card the same way capture does', async () => {
    const body = { type: 'ru_to_pl' as const, promptText: null, promptHint: null, answerPl: 'cześć' }
    const first = await (await post(body)).json()
    const second = await (await post(body)).json()
    expect(second).toEqual({ cardId: first.cardId, duplicateOf: first.cardId })
  })

  // Picture cards are removed (spec §9): nothing may create one any more.
  it('rejects an image_to_pl card', async () => {
    const res = await POST(
      new Request('http://test/api/cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'image_to_pl', promptText: null, promptHint: null, answerPl: 'kot' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})
