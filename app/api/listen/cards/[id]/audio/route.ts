import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { buildCardAudio } from '@/lib/audio/card-audio'
import { FfmpegMissingError, getEncoder } from '@/lib/audio/ffmpeg'
import { settingsToSequence } from '@/lib/audio/sequence'
import { eligibleCard, listenCardOf } from '@/lib/listen/service'
import { getMedia } from '@/lib/media/store'
import { getSettings } from '@/lib/settings'
import { getSynthesizer } from '@/lib/tts'

/**
 * A card's listening MP3 (spec 2026-09-19-hands-free-audio §4.2). Builds (or
 * reuses the cache for) the card+settings' audio and serves it as
 * `audio/mpeg`, content-addressed by its cache key so the response can be
 * cached forever.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const card = eligibleCard(db, id)
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const s = settingsToSequence(getSettings(db))
  let built
  try {
    built = await buildCardAudio({ db, synth: getSynthesizer(), encoder: getEncoder() }, listenCardOf(card), s, new Date())
  } catch (err) {
    if (err instanceof FfmpegMissingError) return NextResponse.json({ error: 'ffmpeg missing' }, { status: 503 })
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }

  const clip = getMedia(db, built.mediaId)
  if (!clip) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return new Response(new Uint8Array(clip.bytes), {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${built.key}"`,
    },
  })
}
