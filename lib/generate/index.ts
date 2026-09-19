import { GoogleGenAI, type GenerateContentParameters } from '@google/genai'
import { z } from 'zod'
import { gcpProject, vertexLocation } from '../gcp/clients'
import { WORD_KINDS, hasForms, serializeForms } from '../cards/forms'
import { SUGGESTION_KINDS, type Level } from '../topics/rounds'

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

export const SuggestionSchema = z.object({
  topic_name: z.string().describe('Short Polish name of the situation, 2–5 words, e.g. "U lekarza z dzieckiem"'),
  items: z
    .array(
      z.object({
        answer_pl: z.string().describe('Polish word in dictionary form, or a phrase, with diacritics'),
        gloss_ru: z.string().describe('Short Russian gloss: one to three comma-separated senses'),
        kind: z.enum(SUGGESTION_KINDS).describe('slowo for a single word (a się verb counts as one), fraza for anything longer'),
      }),
    )
    .describe('Most useful first'),
})
export type Suggestion = z.infer<typeof SuggestionSchema>

type RowSchema = z.ZodObject<Record<string, z.ZodString | z.ZodEnum>>
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
 * of objects whose fields are strings or string enums (form rows; suggestion
 * items). Anything else throws — extend this function rather than work around
 * it, as before.
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
  /**
   * Whether trying again later can succeed (spec 2026-09-18-generation-queue
   * §6). True only when the request itself failed transiently; a response
   * that arrived but was unusable will be just as unusable next time.
   */
  readonly retryable: boolean

  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'GenerationError'
    this.retryable = opts.retryable ?? false
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 503])

/**
 * Classifies a failed generation *request*. Vertex's 429 does not always carry
 * a status property — in production it arrived as JSON inside the message
 * (`{"error":{"code":429,…,"status":"RESOURCE_EXHAUSTED"}}`) — so the message
 * is read too. An error with no HTTP status at all is a network failure: the
 * request never got an answer, which is transient by definition.
 */
export function isRetryableRequestError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null
  if (typeof e?.status === 'number') return RETRYABLE_STATUS.has(e.status)
  if (typeof e?.code === 'number') return RETRYABLE_STATUS.has(e.code)
  const message = typeof e?.message === 'string' ? e.message : ''
  const code = /"code"\s*:\s*(\d{3})/.exec(message)
  if (code) return RETRYABLE_STATUS.has(Number(code[1]))
  if (/RESOURCE_EXHAUSTED|UNAVAILABLE/.test(message)) return true
  return err instanceof TypeError || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(message)
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

const SUGGEST_SYSTEM = `Ты помогаешь взрослому человеку, который уже свободно читает и говорит по-польски, подготовиться к конкретной ситуации. Он описывает ситуацию, а ты предлагаешь польскую лексику, которая ему там понадобится.

Правила:
- Уровень человека указан в запросе — подбирай лексику под него. Базовые слова вроде «lekarz», «dziecko», «chory» не предлагай ни на каком уровне.
- kind:
  - slowo — одно слово в словарной форме; возвратный глагол с «się» — тоже одно слово;
  - fraza — всё длиннее одного слова: сочетание, реплика, вопрос, ответ. Фразы — то, что реально говорят или слышат в этой ситуации, а не книжные предложения.
- answer_pl — по-польски, с правильной диакритикой.
- gloss_ru — короткий перевод на русский: одно-три значения через запятую, в том смысле, который нужен в этой ситуации.
- Никогда не используй английский язык — never use English anywhere in the output.
- Соблюдай запрошенное количество и соотношение слов и фраз.
- Не повторяй ничего из списка «уже предлагалось» — ни то же слово, ни его другую форму.
- Упорядочи по полезности в этой ситуации: самое нужное — первым.
- topic_name — короткое польское название ситуации, 2–5 слов, например «U lekarza z dzieckiem».`

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

/** For a topic item: the Russian sense the card must be built around, and the situation. Either may be absent. */
export type Meaning = { glossRu: string | null; context: string | null }

export interface Generator {
  fromDictation(transcript: string, meaning?: Meaning): Promise<GeneratedCard>
}

export type SuggestInput = {
  context: string
  /** How many items to ask for (already enlarged for dedup; lib/topics/rounds.ts requestSize). */
  count: number
  words: number
  phrases: number
  /** Every answer_pl the topic has ever been offered. */
  exclude: readonly string[]
  level: Level
}

export interface Suggester {
  suggest(input: SuggestInput): Promise<Suggestion>
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

type Run = <T extends z.ZodObject<Record<string, SupportedField>>>(
  schema: T,
  systemInstruction: string,
  parts: unknown[],
) => Promise<z.infer<T>>

/**
 * One structured Gemini call, shared by card generation and suggestions so
 * both classify failures the same way (retryable request errors; unusable
 * responses are not).
 */
function geminiRunner(opts: { generate?: GenerateFn; model?: string }): Run {
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
      throw new GenerationError(`generation request failed: ${(err as Error).message}`, {
        retryable: isRetryableRequestError(err),
      })
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

  return run
}

/** The user message for a card. Without a meaning it is exactly what a dictation always sent. */
export function dictationMessage(text: string, meaning?: Meaning): string {
  const lines = [`Продиктовано: «${text}»`]
  const parts = [
    meaning?.glossRu ? `Имеется в виду значение: «${meaning.glossRu}».` : null,
    meaning?.context ? `Ситуация, для которой нужна карточка: «${meaning.context}».` : null,
  ].filter(Boolean)
  if (parts.length > 0) lines.push(parts.join(' '))
  lines.push('Сделай карточку.')
  return lines.join('\n\n')
}

export function geminiGenerator(opts: { generate?: GenerateFn; model?: string } = {}): Generator {
  const run = geminiRunner(opts)
  return {
    async fromDictation(transcript, meaning) {
      const text = transcript.trim()
      if (!text) throw new GenerationError('empty transcript')
      // Deliberately does not name the language. The transcript may be Polish
      // or Russian and the alphabet already says which; claiming one here
      // would be asserting something false in the one place the model cannot
      // check it against the audio.
      return run(GeneratedCardSchema, SYSTEM, [{ text: dictationMessage(text, meaning) }])
    },
  }
}

const LEVEL_LINE: Record<Level, string> = {
  zaawansowany:
    'Уровень: продвинутый. Человек свободно говорит по-польски — не предлагай повседневную лексику; предлагай то, что специфично для ситуации и чего ему, скорее всего, не хватает: термины, устойчивые сочетания, типичные вопросы и ответы.',
  sredni:
    'Уровень: средний (B1). Человек уверенно объясняется по-польски, но в этой области лексики ему не хватает: предлагай употребительные слова и фразы этой ситуации, которых B1 может не знать; самые базовые не предлагай.',
}

export function suggestMessage(input: SuggestInput): string {
  const exclude = input.exclude.length > 0 ? input.exclude.join('; ') : 'ничего'
  return [
    `Ситуация: «${input.context}»`,
    `Нужно ${input.count}: примерно ${input.words} отдельных слов и ${input.phrases} фраз.`,
    LEVEL_LINE[input.level],
    `Уже предлагалось, не повторяй: ${exclude}`,
  ].join('\n\n')
}

export function geminiSuggester(opts: { generate?: GenerateFn; model?: string } = {}): Suggester {
  const run = geminiRunner(opts)
  return {
    async suggest(input) {
      const context = input.context.trim()
      if (!context) throw new GenerationError('empty context')
      return run(SuggestionSchema, SUGGEST_SYSTEM, [{ text: suggestMessage({ ...input, context }) }])
    },
  }
}

export function getGenerator(): Generator {
  return geminiGenerator()
}

export function getSuggester(): Suggester {
  return geminiSuggester()
}
