import { answerKey } from '../cards/answer-key'

/**
 * The pure rules of a topic's batches (spec 2026-09-18-topic-generation §2,
 * §5; levels and only-kinds: spec 2026-09-19-topic-items §4.5). Nothing here
 * touches the database or the model.
 */

/** ASCII, like WORD_KINDS's `przyslowek`; the screen shows `słowo`. */
export const SUGGESTION_KINDS = ['slowo', 'fraza'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const MIXES = ['mieszane', 'slowa', 'frazy'] as const
export type Mix = (typeof MIXES)[number]

export const LEVELS = ['zaawansowany', 'sredni'] as const
export type Level = (typeof LEVELS)[number]

export const COUNTS = [5, 10, 20] as const
export const DEFAULT_COUNT = 10

export type BatchParams = { count: number; mix: Mix; level: Level }

/** `slowa`/`frazy` mean only that kind — 100% of the request goes to it. */
const WORD_SHARE: Record<Mix, number> = { mieszane: 0.5, slowa: 1, frazy: 0 }

/** How many items to ask the model for, leaving room for dedup to drop some. */
export function requestSize(count: number): number {
  return Math.ceil(count * 1.5)
}

export function mixTarget(n: number, mix: Mix): { words: number; phrases: number } {
  const words = Math.round(n * WORD_SHARE[mix])
  return { words, phrases: n - words }
}

export type SuggestedItem = { answer_pl: string; gloss_ru: string; kind: SuggestionKind }

/**
 * The batch that is shown: the model's items in its order (most useful first),
 * minus empty ones, anything whose answer key is in `taken` (the deck and the
 * topic's history), repeats within the response, and — for `slowa`/`frazy` —
 * anything of the other kind; at most `count` of them. A shorter batch is
 * fine — it is never padded.
 */
export function pickBatch(
  items: readonly SuggestedItem[],
  taken: ReadonlySet<string>,
  count: number,
  mix: Mix,
): SuggestedItem[] {
  const seen = new Set(taken)
  const out: SuggestedItem[] = []
  for (const it of items) {
    if (out.length === count) break
    const answer = it.answer_pl.trim()
    if (!answer) continue
    const key = answerKey(answer)
    if (seen.has(key)) continue
    seen.add(key)
    if (mix === 'slowa' && it.kind !== 'slowo') continue
    if (mix === 'frazy' && it.kind !== 'fraza') continue
    out.push({ answer_pl: answer, gloss_ru: it.gloss_ru.trim(), kind: it.kind })
  }
  return out
}
