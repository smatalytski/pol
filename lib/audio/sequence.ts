import { createHash } from 'node:crypto'
import { VOICES } from '../tts'

export const ASSEMBLY_VERSION = 1

export type SequenceSettings = { gapSeconds: number; repeatAnswer: boolean; example: boolean }

export type SpokenPart =
  | { kind: 'speech'; lang: 'pl' | 'ru'; text: string }
  | { kind: 'silence'; ms: number }

export type ListenCard = {
  promptText: string
  promptHint: string | null
  answerPl: string
  examplePl: string | null
}

/**
 * Builds the sequence of spoken parts and silences for a card.
 *
 * Sequence:
 * 1. RU prompt_text (+ ". " + prompt_hint when present)
 * 2. silence: gapSeconds
 * 3. PL answer_pl
 * 4. if repeatAnswer: 1000 ms silence + PL answer_pl
 * 5. if example and example_pl: 1000 ms silence + PL example_pl
 * 6. 2000 ms trailing silence
 */
export function sequenceFor(card: ListenCard, s: SequenceSettings): SpokenPart[] {
  const parts: SpokenPart[] = []

  // 1. RU prompt (+ hint if present)
  const promptText = card.promptText.trim()
  const hintText = card.promptHint?.trim()
  const ruText = hintText ? `${promptText}. ${hintText}` : promptText
  parts.push({ kind: 'speech', lang: 'ru', text: ruText })

  // 2. Silence (gap)
  parts.push({ kind: 'silence', ms: s.gapSeconds * 1000 })

  // 3. PL answer
  const answerText = card.answerPl.trim()
  parts.push({ kind: 'speech', lang: 'pl', text: answerText })

  // 4. Repeat answer if enabled
  if (s.repeatAnswer) {
    parts.push({ kind: 'silence', ms: 1000 })
    parts.push({ kind: 'speech', lang: 'pl', text: answerText })
  }

  // 5. Example if enabled and present
  const exampleText = card.examplePl?.trim()
  if (s.example && exampleText) {
    parts.push({ kind: 'silence', ms: 1000 })
    parts.push({ kind: 'speech', lang: 'pl', text: exampleText })
  }

  // 6. Trailing silence
  parts.push({ kind: 'silence', ms: 2000 })

  return parts
}

/**
 * Computes a stable SHA-256 cache key for a card's audio sequence.
 * The key includes the assembly version, voice names, and the sequence itself.
 */
export function audioKey(card: ListenCard, s: SequenceSettings): string {
  const parts = sequenceFor(card, s)
  const hashInput = JSON.stringify({ v: ASSEMBLY_VERSION, voices: VOICES, parts })
  return createHash('sha256').update(hashInput).digest('hex')
}

/**
 * Estimates the duration of a sequence in milliseconds.
 * Calculation: 60 ms per character of spoken text, plus all silences.
 */
export function estimateMs(parts: SpokenPart[]): number {
  let totalMs = 0

  for (const part of parts) {
    if (part.kind === 'speech') {
      totalMs += part.text.length * 60
    } else {
      totalMs += part.ms
    }
  }

  return totalMs
}

/**
 * Converts settings from their stored form (0/1 numbers) to the sequence form (booleans).
 */
export function settingsToSequence(settings: {
  audioGapSeconds: number
  audioRepeatAnswer: number
  audioExample: number
}): SequenceSettings {
  return {
    gapSeconds: settings.audioGapSeconds,
    repeatAnswer: settings.audioRepeatAnswer !== 0,
    example: settings.audioExample !== 0,
  }
}
