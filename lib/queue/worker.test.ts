import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/testing'
import { eq } from 'drizzle-orm'
import { cards, captures, generationJobs } from '../db/schema'
import { GenerationError, type GeneratedCard } from '../generate'
import { createCapture, recognizeCapture } from '../capture/pipeline'
import { promoteApproved } from './jobs'
import { createTicker } from './worker'

const NOW = new Date('2026-09-18T10:00:00')
const later = (ms: number) => new Date(NOW.getTime() + ms)
const GENERATED: GeneratedCard = {
  answer_pl: 'kot', prompt_ru: 'кот', prompt_hint: '', example_pl: '', example_ru: '', grammar_note: '',
  kind: 'rzeczownik', forms_basic: [{ label: 'M. l.mn.', value: 'koty' }], forms_extended: [],
}

function deps(fromDictation = vi.fn().mockResolvedValue(GENERATED)) {
  const { db } = createTestDb()
  return { db, transcriber: { transcribe: vi.fn().mockResolvedValue('kot') }, generator: { fromDictation }, clock: () => NOW }
}

function ticker(d: ReturnType<typeof deps>, state = { pausedUntil: 0 }) {
  return createTicker({ db: d.db, providers: () => d as never, state, random: () => 0, onError: (err) => { throw err } })
}

async function dictate(d: ReturnType<typeof deps>) {
  const id = createCapture(d.db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, NOW)
  await recognizeCapture(d, id)
  return id
}

describe('tick', () => {
  it('turns an approved recording into a card', async () => {
    const d = deps()
    await dictate(d)
    const tick = ticker(d)
    expect(await tick(later(9_999))).toBe('idle')
    expect(await tick(later(10_000))).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
    expect(d.db.select().from(captures).get()!.status).toBe('generated')
  })

  it('waits out a 429 and then succeeds', async () => {
    const d = deps(vi.fn().mockRejectedValueOnce(new GenerationError('429', { retryable: true })).mockResolvedValue(GENERATED))
    await dictate(d)
    const state = { pausedUntil: 0 }
    const tick = ticker(d, state)
    expect(await tick(later(10_000))).toBe('retry')
    expect(await tick(later(11_000))).toBe('paused')
    expect(await tick(new Date(state.pausedUntil))).toBe('done')
    expect(d.db.select().from(cards).all()).toHaveLength(1)
  })

  it('never generates a rejected recording', async () => {
    const d = deps()
    await dictate(d)
    d.db.delete(captures).run()
    await ticker(d)(later(10_000))
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
  })

  it('never generates a recording rejected after it was queued: its job goes with it', async () => {
    const d = deps()
    const id = await dictate(d)
    expect(promoteApproved(d.db, later(10_000)).queued).toEqual([id])
    d.db.delete(captures).where(eq(captures.id, id)).run()
    expect(d.db.select().from(generationJobs).all()).toEqual([])
    expect(await ticker(d)(later(11_000))).toBe('idle')
    expect(d.generator.fromDictation).not.toHaveBeenCalled()
  })

  // Promotion is what takes an approved word off /dodaj and puts it on
  // /fiszki; skipping it while a slow Gemini call runs leaves the word on
  // neither screen.
  it('promotes an approved recording while a job is still running', async () => {
    let release!: (card: GeneratedCard) => void
    const d = deps(vi.fn(() => new Promise<GeneratedCard>((resolve) => { release = resolve })))
    await dictate(d)
    const tick = ticker(d)
    const running = tick(later(10_000))
    const b = createCapture(d.db, { bytes: new Uint8Array([1]), mime: 'audio/webm' }, later(5_000))
    await recognizeCapture({ ...d, clock: () => later(5_000) }, b)
    expect(await tick(later(15_000))).toBe('busy')
    expect(d.db.select().from(captures).where(eq(captures.id, b)).get()!.status).toBe('queued')
    release(GENERATED)
    expect(await running).toBe('done')
  })
})
