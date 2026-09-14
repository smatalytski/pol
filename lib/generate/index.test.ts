import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GeneratedCardSchema,
  GenerationError,
  geminiGenerator,
  responseSchemaFor,
  toCardFields,
} from './index'

const FULL = {
  answer_pl: 'złośliwy',
  prompt_ru: 'злобный, ехидный',
  prompt_hint: 'прилагательное, о человеке',
  example_pl: 'Zrobił to ze złośliwości.',
  example_ru: 'Он сделал это из злобы.',
  grammar_note: '',
}

const ok = (payload: unknown) => vi.fn().mockResolvedValue({ text: JSON.stringify(payload) })
const make = (generate: ReturnType<typeof ok>, model = 'gemini-pro-test') =>
  geminiGenerator({ generate: generate as never, model })

describe('responseSchemaFor', () => {
  it('derives a required-string schema from the Zod schema, so the two cannot drift', () => {
    const schema = responseSchemaFor(GeneratedCardSchema) as {
      type: string
      properties: Record<string, { type: string; description?: string }>
      required: string[]
    }
    const keys = Object.keys(GeneratedCardSchema.shape)
    expect(schema.type).toBe('OBJECT')
    expect(Object.keys(schema.properties)).toEqual(keys)
    expect(schema.required).toEqual(keys)
    expect(Object.values(schema.properties).every((p) => p.type === 'STRING')).toBe(true)
  })

  it('carries the Zod field descriptions through, since they are the model instructions', () => {
    const schema = responseSchemaFor(GeneratedCardSchema) as {
      properties: Record<string, { description?: string }>
    }
    expect(schema.properties.answer_pl.description).toMatch(/diacritic/i)
  })
})

describe('toCardFields', () => {
  it('maps empty strings to null so the DB holds null, not ""', () => {
    expect(toCardFields({ ...FULL, example_pl: '', example_ru: '' })).toEqual({
      promptText: 'злобный, ехидный',
      promptHint: 'прилагательное, о человеке',
      answerPl: 'złośliwy',
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
    })
  })

  it('keeps populated fields', () => {
    expect(toCardFields(FULL).examplePl).toBe('Zrobił to ze złośliwości.')
  })
})

describe('geminiGenerator.fromPolish', () => {
  it('returns the parsed card', async () => {
    expect(await make(ok(FULL)).fromPolish('złośliwy')).toEqual(FULL)
  })

  it('sends the transcript, the configured model, and the schema', async () => {
    const generate = ok(FULL)
    await make(generate, 'gemini-pro-xyz').fromPolish('na wszelki wypadek')
    const req = generate.mock.calls[0][0] as {
      model: string
      contents: unknown
      config: { responseMimeType: string; responseSchema: unknown }
    }
    expect(req.model).toBe('gemini-pro-xyz')
    expect(JSON.stringify(req.contents)).toContain('na wszelki wypadek')
    expect(req.config.responseMimeType).toBe('application/json')
    expect(req.config.responseSchema).toBeDefined()
  })

  it('instructs the model that answers are Polish and prompts Russian, never English', async () => {
    const generate = ok(FULL)
    await make(generate).fromPolish('złośliwy')
    const system = (generate.mock.calls[0][0] as { config: { systemInstruction: string } }).config
      .systemInstruction
    // Pinned to the direction-setting rule lines themselves, not merely to
    // "русском"/"польском" appearing anywhere — those words also occur in
    // the prompt's intro sentence, which would leave this test green even
    // if the actual rule bullets were deleted.
    expect(system).toMatch(/prompt_ru\s+всегда\s+на\s+русском/i)
    expect(system).toMatch(/answer_pl\s+всегда\s+на\s+польском/i)
    expect(system).toMatch(/never|никогда/i)
  })

  it('throws GenerationError when the response has no text', async () => {
    const generate = vi.fn().mockResolvedValue({ text: null })
    await expect(
      geminiGenerator({ generate: generate as never }).fromPolish('x'),
    ).rejects.toThrow(GenerationError)
  })

  it('throws GenerationError on unparseable output rather than leaking a SyntaxError', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'not json at all' })
    await expect(
      geminiGenerator({ generate: generate as never }).fromPolish('x'),
    ).rejects.toThrow(GenerationError)
  })

  it('throws GenerationError when the payload fails the schema', async () => {
    await expect(make(ok({ answer_pl: 'złośliwy' })).fromPolish('x')).rejects.toThrow(
      GenerationError,
    )
  })

  it('rejects an empty transcript before spending a request', async () => {
    const generate = ok(FULL)
    await expect(make(generate).fromPolish('   ')).rejects.toThrow(GenerationError)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('geminiGenerator.fromImage', () => {
  it('sends the image as an inlineData part', async () => {
    const generate = ok(FULL)
    await make(generate).fromImage({ bytes: new Uint8Array([1, 2]), mime: 'image/webp' })
    const contents = (generate.mock.calls[0][0] as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }).contents
    const part = contents[0].parts.find((x) => 'inlineData' in x) as {
      inlineData: { mimeType: string; data: string }
    }
    expect(part.inlineData.mimeType).toBe('image/webp')
    expect(part.inlineData.data).toBe(Buffer.from([1, 2]).toString('base64'))
  })
})

describe('geminiGenerator.forms', () => {
  it('returns a Polish prompt and a Polish answer table', async () => {
    const payload = { prompt_pl: 'przyzwyczaić się — wszystkie formy', answer_pl: '…' }
    expect(await make(ok(payload)).forms('przyzwyczaić się')).toEqual(payload)
  })
})

describe('geminiGenerator model resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws a clean GenerationError, not an obscure failure, when FISZKI_MODEL is unset and no model is passed', () => {
    vi.stubEnv('FISZKI_MODEL', undefined)
    expect(() => geminiGenerator({ generate: ok(FULL) as never })).toThrow(GenerationError)
    expect(() => geminiGenerator({ generate: ok(FULL) as never })).toThrow(/FISZKI_MODEL/)
  })
})
