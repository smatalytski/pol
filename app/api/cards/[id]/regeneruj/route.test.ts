import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { GeneratedCard } from '@/lib/generate'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-regen-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const fromDictationMock = vi.fn().mockResolvedValue({
  prompt_ru: 'здоров как бык',
  prompt_hint: 'идиома',
  answer_pl: 'zdrów jak ryba',
  example_pl: 'Czuję się zdrów jak ryba.',
  example_ru: 'Чувствую себя здоровым.',
  grammar_note: 'краткая форма',
  kind: 'fraza',
  forms_basic: [],
  forms_extended: [],
} satisfies GeneratedCard)

// Mocks only the generation seam, so the route's own db lookups run unmocked.
vi.mock('@/lib/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generate')>()
  return { ...actual, getGenerator: () => ({ ...actual.getGenerator(), fromDictation: fromDictationMock }) }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { newState } = await import('@/lib/scheduler')
const { GenerationError } = await import('@/lib/generate')

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
  db.delete(cards).run()
  fromDictationMock.mockClear()
})

describe('POST /api/cards/:id/regeneruj', () => {
  it('repairs a stranded card and returns it', async () => {
    seedStranded('c1')
    const res = await post('c1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.duplicateOf).toBeNull()
    expect(body.card.status).toBe('ready')
    expect(body.card.promptText).toBe('здоров как бык')
    expect(db.select().from(cards).where(eq(cards.id, 'c1')).get()!.status).toBe('ready')
  })

  // A second 429 is the expected failure for this route specifically — a
  // transient 429 is what stranded the card in the first place. It must come
  // back as something the row can display, and must leave the card stranded
  // rather than half-written, so the button can be pressed again.
  it('surfaces a generation failure as a client error and leaves the card stranded', async () => {
    seedStranded('c2')
    fromDictationMock.mockRejectedValueOnce(
      new GenerationError('generation request failed: 429 RESOURCE_EXHAUSTED'),
    )
    const res = await post('c2')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/RESOURCE_EXHAUSTED/)
    const row = db.select().from(cards).where(eq(cards.id, 'c2')).get()!
    expect(row.status).toBe('needs_input')
    expect(row.promptText).toBeNull()
  })
})
