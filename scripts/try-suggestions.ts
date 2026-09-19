// Live check of the suggestion prompt (spec 2026-09-18-topic-generation §7):
// one round for each of the three example situations, printed for a human to
// judge. Not a test — the question is whether the words are good.
//
// Usage: npx tsx --env-file=.env.local scripts/try-suggestions.ts [count] [mix]
// Needs GOOGLE_CLOUD_PROJECT, FISZKI_MODEL and ADC, like check-providers.

import { getSuggester } from '../lib/generate/index'
import { MIXES, mixTarget, requestSize, type Mix } from '../lib/topics/rounds'

const SITUATIONS = [
  'Иду к врачу с ребёнком, у него грипп: температура, кашель, насморк.',
  'Я программист, работаю над проектом на C++, пользуюсь git и Windows.',
  'Везу машину в сервис.',
]

const count = Number(process.argv[2] ?? 10)
const mix = (process.argv[3] ?? 'mieszane') as Mix
if (!MIXES.includes(mix)) throw new Error(`mix must be one of ${MIXES.join(', ')}`)

const suggester = getSuggester()
for (const context of SITUATIONS) {
  const n = requestSize(count)
  const started = Date.now()
  const s = await suggester.suggest({ context, count: n, ...mixTarget(n, mix), exclude: [], level: 'zaawansowany' })
  console.log(`\n=== ${s.topic_name}  (${Date.now() - started} ms)\n${context}`)
  for (const i of s.items) console.log(`  [${i.kind}] ${i.answer_pl} — ${i.gloss_ru}`)
}
