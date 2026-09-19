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

// Two concurrent buildCardAudio calls for the same (db, key) would otherwise
// both miss the cache and both fetch clips, run the encoder, and putMedia —
// the loser's `listen` media row would be written under a fresh randomUUID
// and never referenced by any card_audio row, a permanent orphan. This
// in-flight map, keyed per Db (mirroring lib/tts/index.ts's getClip), makes
// the second caller await the first caller's in-progress build instead. It
// relies on this function containing no `await` before the map is
// checked-and-set, which keeps that check-and-set atomic with respect to the
// event loop even though this file has no explicit lock.
const inFlight = new WeakMap<Db, Map<string, Promise<CardAudioResult>>>()

/**
 * Builds (or reuses) one card's listening MP3.
 *
 * On a cache hit, returns the existing row untouched — no TTS clip lookup,
 * no encoding. On a miss, fetches (or synthesizes, via `getClip`) each
 * speech part's clip, hands the encoder the ordered parts with silences
 * interleaved, stores the resulting MP3 as a `listen` media row, and
 * records it under this card+settings' key. A `FfmpegMissingError` (or any
 * other error) from the encoder propagates before anything is cached. A
 * second call racing the first for the same card+settings is deduplicated
 * (see `inFlight` above) rather than building — and orphaning — twice.
 */
export async function buildCardAudio(
  deps: { db: Db; synth: Synthesizer; encoder: Encoder },
  card: ListenCard,
  s: SequenceSettings,
  now: Date,
): Promise<CardAudioResult> {
  const { db, synth, encoder } = deps
  const key = audioKey(card, s)

  const cached = cachedAudio(db, card, s)
  if (cached) return cached

  let pending = inFlight.get(db)
  if (!pending) {
    pending = new Map()
    inFlight.set(db, pending)
  }
  const already = pending.get(key)
  if (already) return already

  const promise = (async (): Promise<CardAudioResult> => {
    try {
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

      const mediaId = putMedia(db, { kind: 'listen', mime: 'audio/mpeg', bytes, now })
      // Guarded by the in-flight map above, so this insert should never
      // actually conflict; onConflictDoNothing is kept only as a defensive
      // fallback (e.g. a future caller bypassing buildCardAudio).
      db.insert(cardAudio)
        .values({ key, mediaId, durationMs, createdAt: now.getTime() })
        .onConflictDoNothing()
        .run()

      const row = db.select().from(cardAudio).where(eq(cardAudio.key, key)).get()!
      return { mediaId: row.mediaId, durationMs: row.durationMs, key: row.key }
    } finally {
      pending!.delete(key)
    }
  })()
  pending.set(key, promise)
  return promise
}
