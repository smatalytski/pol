import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/testing'
import { cards, captures } from '../db/schema'
import { GenerationError, type GeneratedCard } from '../generate'
import { createCapture, recognizeCapture } from '../capture/pipeline'
import { tick } from './worker'

const NOW = new Date('2026-09-18T10:00:00')
const later = (ms: number) => new Date(NOW.getTime() + ms)
const GENERATED: GeneratedCard = {
  answer_pl: 'kot', prompt_ru: 'кот', prompt_hint: '', example_pl: '', example_ru: '', grammar_note: '',
  kind: 'rzeczownik', forms_basic: [{ label: 'M. l.mn.', value: 'koty' }], forms_extended: [],
}

function deps(fromDictation = vi.fn().mockResolvedValue(GENERATED)) {
  const { db } = createTestDb()
  return { db, transcriber: { transcribe: vi.fn().mockResolvedValue('kot') }, generator: { fromDictation } }
}

async function dictate(d: ReturnType<typeof deps>) {
  const id = createCapture(d.db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, NOW)
  await recognizeCapture(d, id, NOW)
  return id
}

describe('tick', () => {
  it('turns an approved recording into a card', async () => {
    const d = deps()
    await dictate(d)
    expect(await tick(d as never, { pausedUntil: 0 }, later(9_999), () => 0)).toBe('idle')
    expect(await tick(d as never, { pausedUntil: 0 }, later(10_000), () => 0)).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(captures).get()!.status).toBe('generated')
  })

  it('waits out a 429 and then succeeds', async () => {
    const d = deps(vi.fn().mockRejectedValueOnce(new GenerationError('429', { retryable: true })).mockResolvedValue(GENERATED))
    await dictate(d)
    const state = { pausedUntil: 0 }
    expect(await tick(d as never, state, later(10_000), () => 0)).toBe('retry')
    expect(await tick(d as never, state, later(11_000), () => 0)).toBe('paused')
    expect(await tick(d as never, state, new Date(state.pausedUntil), () => 0)).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
  })

  it('never generates a rejected recording', async () => {
    const d = deps()
    const id = await dictate(d)
    d.db.delete(captures).run()
    await tick(d as never, { pausedUntil: 0 }, later(10_000), () => 0)
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
    expect(id).toBeTruthy()
  })
})
