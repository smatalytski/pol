import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { cardAudio } from '../db/schema'
import { getMedia, putMedia } from '../media/store'
import { getClip, type Synthesizer } from '../tts'
import type { Encoder, EncodePart } from './ffmpeg'
import { audioKey, sequenceFor, type ListenCard, type SequenceSettings } from './sequence'

export type CardAudioResult = { mediaId: string; durationMs: number; key: string }

/** The already-cached row for this card and settings, or null if it hasn't been built yet. */
export function cachedAudio(db: Db, card: ListenCard, s: SequenceSettings): CardAudioResult | null {
  const key = audioKey(card, s)
  const row = db.select().from(cardAudio).where(eq(cardAudio.key, key)).get()
  if (!row) return null
  return { mediaId: row.mediaId, durationMs: row.durationMs, key }
}

/**
 * Builds (or reuses) one card's listening MP3.
 *
 * On a cache hit, returns the existing row untouched — no TTS clip lookup,
 * no encoding. On a miss, fetches (or synthesizes, via `getClip`) each
 * speech part's clip, hands the encoder the ordered parts with silences
 * interleaved, stores the resulting MP3 as a `listen` media row, and
 * records it under this card+settings' key. A `FfmpegMissingError` (or any
 * other error) from the encoder propagates before anything is cached.
 */
export async function buildCardAudio(
  deps: { db: Db; synth: Synthesizer; encoder: Encoder },
  card: ListenCard,
  s: SequenceSettings,
  now: Date,
): Promise<CardAudioResult> {
  const { db, synth, encoder } = deps

  const cached = cachedAudio(db, card, s)
  if (cached) return cached

  const parts = sequenceFor(card, s)
  const encodeParts: EncodePart[] = []
  for (const part of parts) {
    if (part.kind === 'silence') {
      encodeParts.push({ kind: 'silence', ms: part.ms })
      continue
    }
    const mediaId = await getClip(db, synth, part.text, part.lang, now)
    const clip = getMedia(db, mediaId)
    if (!clip) throw new Error(`missing media row for clip ${mediaId}`)
    encodeParts.push({ kind: 'clip', bytes: clip.bytes })
  }

  const { bytes, durationMs } = await encoder.encode(encodeParts)

  const key = audioKey(card, s)
  const mediaId = putMedia(db, { kind: 'listen', mime: 'audio/mpeg', bytes, now })
  db.insert(cardAudio)
    .values({ key, mediaId, durationMs, createdAt: now.getTime() })
    .onConflictDoNothing()
    .run()

  const row = db.select().from(cardAudio).where(eq(cardAudio.key, key)).get()!
  return { mediaId: row.mediaId, durationMs: row.durationMs, key: row.key }
}
