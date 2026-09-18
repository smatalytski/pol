import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-typ-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { createCard } = await import('@/lib/cards/service')

const NOW = new Date('2026-09-18T10:00:00')

function seed(wordKind: 'rzeczownik' | 'fraza', formsJson: string | null) {
  return createCard(
    db,
    {
      type: 'ru_to_pl', promptText: 'кот', promptHint: null, answerPl: 'kot', examplePl: null,
      exampleRu: null, grammarNote: null, wordKind, formsJson, status: 'ready',
    },
    NOW,
  ).cardId
}

function post(id: string, body: unknown) {
  return POST(
    new Request(`http://test/api/cards/${id}/typ`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  db.delete(cards).run()
})

describe('POST /api/cards/:id/typ', () => {
  it('switches the card and returns it', async () => {
    const id = seed('rzeczownik', JSON.stringify({ basic: [{ label: 'M. l.mn.', value: 'koty' }], extended: [] }))
    const res = await post(id, { type: 'pl_to_pl' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.card.type).toBe('pl_to_pl')
    expect(body.duplicateOf).toBeNull()
  })

  it('rejects a type the app does not have', async () => {
    const id = seed('rzeczownik', null)
    expect((await post(id, { type: 'image_to_pl' })).status).toBe(400)
  })

  it('answers 400 with a message when the word has no forms', async () => {
    const id = seed('fraza', null)
    const res = await post(id, { type: 'pl_to_pl' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/forms/)
  })
})
