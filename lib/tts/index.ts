import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { TextToSpeechClient, type protos } from '@google-cloud/text-to-speech'
import type { Db } from '../db/client'
import { ttsClips } from '../db/schema'
import { speechLocation } from '../gcp/clients'
import { putMedia } from '../media/store'
import { type Lang, VOICES } from './voices'

export type { Lang }
export { VOICES }

const LANGUAGE_CODES: Record<Lang, string> = { pl: 'pl-PL', ru: 'ru-RU' }

// The SDK's own request type, read from the installed package rather than
// guessed, so a misspelled or misnested field fails `tsc`, not just at
// runtime against the real API.
type SynthesizeSpeechRequest = protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest

export interface Synthesizer {
  synthesize(text: string, lang: Lang): Promise<{ bytes: Uint8Array; mime: string; voice: string }>
}

export function clipId(text: string, lang: Lang, voice: string): string {
  return createHash('sha256').update(`${text}|${lang}|${voice}`).digest('hex')
}

// Two concurrent getClip calls for the same (db, text, lang) would otherwise
// both miss the cache and both call the synthesizer — wasteful, and on the
// second insert, a primary-key conflict. This in-flight map, keyed per Db,
// makes the second caller await the first caller's in-progress work instead.
// It relies on getClip's own body containing no `await` before this map is
// checked-and-set, which keeps that check-and-set atomic with respect to the
// event loop even though this file has no explicit lock.
const inFlight = new WeakMap<Db, Map<string, Promise<string>>>()

export async function getClip(
  db: Db,
  synth: Synthesizer,
  text: string,
  lang: Lang,
  now: Date,
): Promise<string> {
  const id = clipId(text, lang, VOICES[lang])
  const existing = db.select().from(ttsClips).where(eq(ttsClips.id, id)).get()
  if (existing) return existing.mediaId

  let pending = inFlight.get(db)
  if (!pending) {
    pending = new Map()
    inFlight.set(db, pending)
  }
  const already = pending.get(id)
  if (already) return already

  const promise = (async () => {
    try {
      const { bytes, mime, voice } = await synth.synthesize(text, lang)
      const mediaId = putMedia(db, { kind: 'tts', mime, bytes, now })
      // Content-addressed: the same (text, lang, voice) always produces this
      // same id, so a second writer racing us here is a benign duplicate, not
      // a bug. Tolerate it instead of throwing, then read back whichever row
      // won — our own or the racing writer's, which point at equivalent audio.
      db.insert(ttsClips)
        .values({ id, mediaId, lang, voice, text, createdAt: now.getTime() })
        .onConflictDoNothing()
        .run()
      return db.select().from(ttsClips).where(eq(ttsClips.id, id)).get()!.mediaId
    } finally {
      pending!.delete(id)
    }
  })()
  pending.set(id, promise)
  return promise
}

export type SynthesizeFn = (
  req: unknown,
) => Promise<[{ audioContent?: Uint8Array | string | null }, ...unknown[]]>

export function ttsSynthesizer(opts: { synthesizeSpeech: SynthesizeFn }): Synthesizer {
  return {
    async synthesize(text, lang) {
      const req: SynthesizeSpeechRequest = {
        input: { text },
        voice: { languageCode: LANGUAGE_CODES[lang], name: VOICES[lang] },
        audioConfig: { audioEncoding: 'MP3' },
      }
      let audioContent: Uint8Array | string | null | undefined
      try {
        ;[{ audioContent }] = await opts.synthesizeSpeech(req)
      } catch (err) {
        throw new Error(`tts failed: ${(err as Error).message}`)
      }
      if (!audioContent) throw new Error('tts failed: no audioContent')

      // The client returns Buffer/Uint8Array over gRPC but base64 over REST.
      // Accept both rather than depending on which transport is in use.
      const bytes =
        typeof audioContent === 'string'
          ? new Uint8Array(Buffer.from(audioContent, 'base64'))
          : new Uint8Array(audioContent)

      return { bytes, mime: 'audio/mpeg', voice: VOICES[lang] }
    },
  }
}

export function getSynthesizer(): Synthesizer {
  const client = new TextToSpeechClient({
    apiEndpoint: `${speechLocation()}-texttospeech.googleapis.com`,
  })
  return ttsSynthesizer({
    synthesizeSpeech: (req) => client.synthesizeSpeech(req as never) as never,
  })
}
