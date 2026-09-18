import { answerKey } from '../cards/answer-key'

/**
 * The pure rules of a topic's rounds (spec 2026-09-18-topic-generation §2, §5).
 * Nothing here touches the database or the model.
 */

/** ASCII, like WORD_KINDS's `przyslowek`; the screen shows `słowo`. */
export const SUGGESTION_KINDS = ['slowo', 'fraza'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const MIXES = ['mieszane', 'slowa', 'frazy'] as const
export type Mix = (typeof MIXES)[number]

export const COUNTS = [5, 10, 20] as const
export const DEFAULT_COUNT = 10

export type RoundParams = { count: number; mix: Mix }

const WORD_SHARE: Record<Mix, number> = { mieszane: 0.5, slowa: 0.8, frazy: 0.2 }

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
 * The round that is shown: the model's items in its order (most useful first),
 * minus empty ones, anything whose answer key is in `taken` (the deck and the
 * topic's history), and repeats within the response; at most `count` of them.
 * A shorter round is fine — it is never padded.
 */
export function pickRound(items: readonly SuggestedItem[], taken: ReadonlySet<string>, count: number): SuggestedItem[] {
  const seen = new Set(taken)
  const out: SuggestedItem[] = []
  for (const it of items) {
    if (out.length === count) break
    const answer = it.answer_pl.trim()
    if (!answer) continue
    const key = answerKey(answer)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ answer_pl: answer, gloss_ru: it.gloss_ru.trim(), kind: it.kind })
  }
  return out
}
