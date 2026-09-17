import { GoogleGenAI, type GenerateContentParameters } from '@google/genai'
import { z } from 'zod'
import { gcpProject, vertexLocation } from '../gcp/clients'

export const GeneratedCardSchema = z.object({
  answer_pl: z.string().describe('The Polish word, phrase or sentence, correctly spelled with diacritics'),
  prompt_ru: z.string().describe('The Russian prompt that should elicit answer_pl'),
  prompt_hint: z.string().describe('Short Russian disambiguator: part of speech and context; "" if unnecessary'),
  example_pl: z.string().describe('One short natural Polish sentence using it; "" if not useful'),
  example_ru: z.string().describe('Russian translation of example_pl; "" if example_pl is ""'),
  grammar_note: z.string().describe('Short POLISH note on gender, aspect or case governance; "" if unremarkable'),
})
export type GeneratedCard = z.infer<typeof GeneratedCardSchema>

export const GeneratedFormsSchema = z.object({
  prompt_pl: z.string().describe('The Polish lemma plus what forms are being asked for'),
  answer_pl: z.string().describe('The form table as compact Markdown, Polish only'),
})
export type GeneratedForms = z.infer<typeof GeneratedFormsSchema>

/**
 * Derive Gemini's responseSchema from the Zod schema, so the schema is declared
 * exactly once. Sound only because every field is a required string — which is
 * a deliberate design choice, not a coincidence. A non-string field added later
 * must extend this function rather than work around it.
 */
export function responseSchemaFor(schema: z.ZodObject<Record<string, z.ZodString>>) {
  const shape = schema.shape
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(
      Object.entries(shape).map(([key, field]) => [
        key,
        { type: 'STRING', description: field.description ?? '' },
      ]),
    ),
    required: Object.keys(shape),
  }
}

export class GenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationError'
  }
}

const SYSTEM = `Ты помогаешь взрослому человеку, который уже свободно читает и говорит по-польски, закреплять слова и конструкции, которые он встретил и хочет запомнить.

Ты делаешь карточки для тренировки ПРОДУКТИВНОГО навыка: вопрос на русском, ответ на польском.

Правила:
- answer_pl всегда на польском, с правильной орфографией и диакритикой. Вход приходит из распознавания речи и часто теряет ł, ś, ż, ć, ó — восстанавливай их. Если слово продиктовано в косвенной форме внутри фразы, приведи его к словарной форме, если это отдельное слово; фразы и предложения оставляй как есть.
- prompt_ru всегда на русском.
- Никогда не используй английский язык — never use English anywhere in the output.
- Русский перевод часто неоднозначен: «злобный» может дать złośliwy, wredny или zły. Поэтому для отдельных слов заполняй prompt_hint: часть речи и короткий контекст, чтобы вопрос имел понятный ответ. Для целых предложений prompt_hint оставляй пустым.
- example_pl — одно короткое естественное предложение. Не выдумывай книжных конструкций.
- grammar_note заполняй только когда есть что сказать: род существительного, вид глагола и его пара, управление падежом. Пиши grammar_note ПО-ПОЛЬСКИ — она показывается на обратной стороне карточки, где всё по-польски.
- Если поле не нужно, верни пустую строку.`

const FORMS_SYSTEM = `Ты делаешь карточку-тренажёр форм для польского языка. prompt_pl — польская лемма и указание, какие формы нужны. answer_pl — компактная таблица форм в Markdown, только по-польски: для глагола — спряжение в настоящем/будущем, форма прошедшего времени по родам, вид и видовая пара; для существительного — склонение в единственном и множественном числе. Никакого английского и никакого русского в answer_pl.`

export function toCardFields(g: GeneratedCard) {
  const orNull = (s: string) => (s.trim() === '' ? null : s)
  return {
    promptText: orNull(g.prompt_ru),
    promptHint: orNull(g.prompt_hint),
    answerPl: g.answer_pl,
    examplePl: orNull(g.example_pl),
    exampleRu: orNull(g.example_ru),
    grammarNote: orNull(g.grammar_note),
  }
}

export interface Generator {
  fromPolish(transcript: string): Promise<GeneratedCard>
  fromImage(image: { bytes: Uint8Array; mime: string }): Promise<GeneratedCard>
  forms(lemma: string): Promise<GeneratedForms>
}

export type GenerateFn = (req: {
  model: string
  contents: unknown
  config: unknown
}) => Promise<{ text?: string | null }>

// A plain `const model = opts.model ?? process.env.FISZKI_MODEL; if (!model) throw ...`
// types `model` as `string | undefined` for any nested closure declared after
// the guard — TS does not carry control-flow narrowing across function
// boundaries. Returning it from a function with an explicit `string` return
// type gives every later use a real `string`, with no cast.
function resolveModel(model?: string): string {
  const resolved = model ?? process.env.FISZKI_MODEL
  if (!resolved) throw new GenerationError('FISZKI_MODEL is not set')
  return resolved
}

export function geminiGenerator(
  opts: { generate?: GenerateFn; model?: string } = {},
): Generator {
  const model = resolveModel(opts.model)

  const generate: GenerateFn =
    opts.generate ??
    (async (req) => {
      // Client construction is deferred to call time (not import time), so
      // this module loads in tests and without ADC — the SDK import itself
      // is static, matching lib/transcribe/index.ts's precedent.
      const ai = new GoogleGenAI({
        vertexai: true,
        project: gcpProject(),
        location: vertexLocation(),
      })
      // Built against the SDK's own GenerateContentParameters (read from
      // node_modules, not guessed), so tsc validates the field names and
      // nesting generateContent actually expects. `contents`/`config` still
      // need a narrowing cast: GenerateFn deliberately types them `unknown`
      // so the seam stays stable if the SDK's shape moves — that seam is not
      // being changed here. The response is a GenerateContentResponse
      // instance whose `.text` getter is `string | undefined`, which is
      // structurally assignable to `{ text?: string | null }` with no cast.
      const params: GenerateContentParameters = {
        model: req.model,
        contents: req.contents as GenerateContentParameters['contents'],
        config: req.config as GenerateContentParameters['config'],
      }
      return ai.models.generateContent(params)
    })

  async function run<T extends z.ZodObject<Record<string, z.ZodString>>>(
    schema: T,
    systemInstruction: string,
    parts: unknown[],
  ): Promise<z.infer<T>> {
    let text: string | null | undefined
    try {
      ;({ text } = await generate({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: responseSchemaFor(schema),
        },
      }))
    } catch (err) {
      throw new GenerationError(`generation request failed: ${(err as Error).message}`)
    }

    if (!text) throw new GenerationError('generation returned no content')

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // Structured output should make this unreachable. If it fires, the
      // request was built wrong — do not start stripping markdown fences.
      throw new GenerationError('generation returned non-JSON despite responseSchema')
    }

    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new GenerationError(`generation returned an unusable payload: ${parsed.error.message}`)
    }
    return parsed.data
  }

  return {
    async fromPolish(transcript) {
      const text = transcript.trim()
      if (!text) throw new GenerationError('empty transcript')
      return run(GeneratedCardSchema, SYSTEM, [
        { text: `Продиктовано по-польски: «${text}»\n\nСделай карточку.` },
      ])
    },

    async fromImage({ bytes, mime }) {
      return run(GeneratedCardSchema, SYSTEM, [
        { inlineData: { mimeType: mime, data: Buffer.from(bytes).toString('base64') } },
        { text: 'Назови по-польски то, что на картинке. prompt_ru — русское название, answer_pl — польское.' },
      ])
    },

    async forms(lemma) {
      const text = lemma.trim()
      if (!text) throw new GenerationError('empty lemma')
      return run(GeneratedFormsSchema, FORMS_SYSTEM, [{ text: `Лемма: «${text}»` }])
    },
  }
}

export function getGenerator(): Generator {
  return geminiGenerator()
}
