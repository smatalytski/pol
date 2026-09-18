import { GoogleGenAI, type GenerateContentParameters } from '@google/genai'
import { z } from 'zod'
import { gcpProject, vertexLocation } from '../gcp/clients'
import { WORD_KINDS, hasForms, serializeForms } from '../cards/forms'

const FormRowSchema = z.object({
  label: z.string().describe('Short Polish grammatical label, e.g. "D. l.poj." or "tryb rozk."'),
  value: z.string().describe('The Polish form, or several joined with " · "'),
})

export const GeneratedCardSchema = z.object({
  answer_pl: z.string().describe('The Polish word, phrase or sentence, correctly spelled with diacritics'),
  prompt_ru: z.string().describe('The Russian prompt that should elicit answer_pl'),
  prompt_hint: z.string().describe('Short Russian disambiguator: part of speech and context; "" if unnecessary'),
  example_pl: z.string().describe('One short natural Polish sentence using it; "" if not useful'),
  example_ru: z.string().describe('Russian translation of example_pl; "" if example_pl is ""'),
  grammar_note: z.string().describe('Short POLISH note on gender, aspect or case governance; "" if unremarkable'),
  kind: z.enum(WORD_KINDS).describe('What was dictated: fraza, or the part of speech of a single word; see the rules'),
  forms_basic: z.array(FormRowSchema).describe('The short list always shown with the answer; [] for fraza and inne'),
  forms_extended: z.array(FormRowSchema).describe('The full list shown on request; [] where the rules give none'),
})
export type GeneratedCard = z.infer<typeof GeneratedCardSchema>

type RowSchema = z.ZodObject<Record<string, z.ZodString>>
export type SupportedField = z.ZodString | z.ZodEnum | z.ZodArray<RowSchema>

function fieldSchema(field: SupportedField): Record<string, unknown> {
  const description = field.description ?? ''
  if (field instanceof z.ZodString) return { type: 'STRING', description }
  if (field instanceof z.ZodEnum) return { type: 'STRING', enum: [...field.options], description }
  if (field instanceof z.ZodArray && field.element instanceof z.ZodObject) {
    return { type: 'ARRAY', description, items: responseSchemaFor(field.element) }
  }
  throw new Error(`responseSchemaFor: unsupported field ${(field as z.ZodType).constructor.name}`)
}

/**
 * Derive Gemini's responseSchema from the Zod schema, so the schema is declared
 * exactly once. Supports exactly three field shapes, because those are all the
 * cards need: a required string, a string enum (the word's kind), and an array
 * of objects whose fields are all strings (a list of form rows). Anything else
 * throws — extend this function rather than work around it, as before.
 */
export function responseSchemaFor(schema: z.ZodObject<Record<string, SupportedField>>) {
  const shape = schema.shape
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, fieldSchema(field)])),
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
- Транскрипт приходит либо по-польски, либо по-русски — тебе не говорят заранее, определи сам по алфавиту:
  - если он по-польски — это ответ: answer_pl это он сам (с восстановленной диакритикой), а prompt_ru ты придумываешь;
  - если он по-русски — это вопрос: prompt_ru это он сам (почищенный от лишней пунктуации), а answer_pl — то, что человек должен суметь сказать по-польски.
- Никогда не используй английский язык — never use English anywhere in the output.
- Русский перевод часто неоднозначен: «злобный» может дать złośliwy, wredny или zły. Поэтому для отдельных слов заполняй prompt_hint: часть речи и короткий контекст, чтобы вопрос имел понятный ответ. Для целых предложений prompt_hint оставляй пустым.
- example_pl — одно короткое естественное предложение. Не выдумывай книжных конструкций.
- grammar_note заполняй только когда есть что сказать: род существительного, вид глагола и его пара, управление падежом. Пиши grammar_note ПО-ПОЛЬСКИ — она показывается на обратной стороне карточки, где всё по-польски.
- Поле kind — что продиктовано:
  - fraza — всё, что не является одной лексической единицей: предложения, идиомы («zdrów jak ryba»), многословные именные группы («kleszczowe zapalenie mózgu»);
  - возвратный глагол с «się» — это одно слово: «przyzwyczaić się» это czasownik, а не fraza;
  - inne — одно слово другой части речи: междометия («cześć»), местоимения, предлоги, числительные;
  - иначе — часть речи: rzeczownik, czasownik, przymiotnik, przyslowek.
- forms_basic показывается вместе с ответом всегда, forms_extended — по нажатию. Каждая строка: label — короткая польская помета, value — форма, несколько форм через « · ». Только по-польски. Для fraza и inne оба списка пустые. Если формы не существует, строку пропускай, не выдумывай.
  - rzeczownik: forms_basic — «M. l.mn.», «D. l.poj.», «D. l.mn.»; forms_extended — «C.», «B.», «Ms.», «N.», в каждой «l.poj. · l.mn.». Wołacz не нужен. Если у слова нет одного из чисел (pluralia или singularia tantum), пропусти эти формы.
  - czasownik: forms_basic — «aspekt» (вид и видовая пара, например «ndk. → dk. zrobić»), затем «ja · ty · oni» настоящего времени, затем «tryb rozk.» для ty. У глагола совершенного вида настоящего времени нет: вместо него дай czas przyszły prosty (ja · ty · oni) с пометой «cz. przyszły». forms_extended — «cz. przeszły l.poj.» (m · ż · n), «cz. przeszły l.mn.» (m-os. · nie-m-os.), «imiesłowy» (только те, что существуют для этого вида: у совершенного нет формы на -ący), «forma bezosobowa».
  - przymiotnik: forms_basic — «przysłówek», образованный от него; forms_extended пустой.
  - przyslowek: forms_basic — «przymiotnik», от которого он образован; forms_extended пустой.
- Если поле не нужно, верни пустую строку.`

export function toCardFields(g: GeneratedCard) {
  const orNull = (s: string) => (s.trim() === '' ? null : s)
  return {
    promptText: orNull(g.prompt_ru),
    promptHint: orNull(g.prompt_hint),
    answerPl: g.answer_pl,
    examplePl: orNull(g.example_pl),
    exampleRu: orNull(g.example_ru),
    grammarNote: orNull(g.grammar_note),
    wordKind: g.kind,
    // The kind decides, not whatever came back in the arrays: a phrase or an
    // `inne` word never carries forms, so a card cannot claim forms its kind
    // has none of (spec 2026-09-18 §3.1).
    formsJson: hasForms(g.kind) ? serializeForms({ basic: g.forms_basic, extended: g.forms_extended }) : null,
  }
}

export interface Generator {
  fromDictation(transcript: string): Promise<GeneratedCard>
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

  async function run<T extends z.ZodObject<Record<string, SupportedField>>>(
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
    async fromDictation(transcript) {
      const text = transcript.trim()
      if (!text) throw new GenerationError('empty transcript')
      // Deliberately does not name the language. The transcript may be Polish
      // or Russian and the alphabet already says which; claiming one here
      // would be asserting something false in the one place the model cannot
      // check it against the audio.
      return run(GeneratedCardSchema, SYSTEM, [
        { text: `Продиктовано: «${text}»\n\nСделай карточку.` },
      ])
    },
  }
}

export function getGenerator(): Generator {
  return geminiGenerator()
}
