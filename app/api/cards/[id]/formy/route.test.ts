import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'fiszki-formy-route-'))
process.env.FISZKI_DB = path.join(tmpDir, 'test.db')
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

const formsMock = vi.fn().mockResolvedValue({ prompt_pl: 'przyzwyczaić się — formy', answer_pl: '| … |' })

// Mocks only the generation seam, same approach as
// app/api/cards/[id]/audio/route.test.ts mocking lib/tts — the db and
// lib/cards/service.ts's createFormsCard run unmocked.
vi.mock('@/lib/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generate')>()
  return { ...actual, getGenerator: () => ({ ...actual.getGenerator(), forms: formsMock }) }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db/client')
const { cards } = await import('@/lib/db/schema')
const { newState } = await import('@/lib/scheduler')
const { GenerationError } = await import('@/lib/generate')

const NOW = new Date('2026-09-12T10:00:00')

function seedCard(overrides: Partial<typeof cards.$inferInsert> & { id: string }) {
  db.insert(cards)
    .values({
      type: 'ru_to_pl',
      promptText: 'привык',
      promptHint: null,
      promptMediaId: null,
      answerPl: 'przyzwyczaić się',
      answerKey: 'przyzwyczaić się',
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

function post(id: string) {
  return POST(new Request(`http://test/api/cards/${id}/formy`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  db.delete(cards).run()
  formsMock.mockClear()
})

describe('POST /api/cards/:id/formy', () => {
  it('creates a pl_forms child card linked to its parent', async () => {
    seedCard({ id: 'parent-1' })
    const res = await post('parent-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    const child = db.select().from(cards).where(eq(cards.id, body.cardId)).get()!
    expect(child.type).toBe('pl_forms')
    expect(child.parentCardId).toBe('parent-1')
  })

  it('is idempotent across two requests', async () => {
    seedCard({ id: 'parent-2' })
    const first = await (await post('parent-2')).json()
    const second = await (await post('parent-2')).json()
    expect(second.cardId).toBe(first.cardId)
    expect(formsMock).toHaveBeenCalledTimes(1)
  })

  // Important review finding: a GenerationError became an unhandled 500 with
  // no body the client could show — and this is not a rare edge case, it's
  // the exact failure this task's own sandbox produced when live-verifying
  // this route (network blocked, so generation always fails there).
  it('surfaces a generation failure as a client error instead of an unhandled 500', async () => {
    seedCard({ id: 'parent-3' })
    formsMock.mockRejectedValueOnce(new GenerationError('generation request failed: network unreachable'))
    const res = await post('parent-3')
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/generation request failed/)
    // No half-made pl_forms child left behind by the failed attempt.
    expect(db.select().from(cards).all()).toHaveLength(1)
  })
})
