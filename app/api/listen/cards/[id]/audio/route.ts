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
 * A card's listening MP3 (spec 2026-09-19-hands-free-audio §4.2). Always
 * builds (or reuses the cache for) the card's CURRENT audio — the bytes
 * change whenever the card is edited or a listening setting changes, so
 * "current" is a moving target, not a fixed one this URL alone can promise.
 * `?k=` is how the caller states which key it expects (normally the
 * `audioKey` a `POST /api/listen/session` plan handed it): when it matches
 * the key just built, this URL and that key really do name the same bytes
 * right now, so the response is safe to cache forever
 * (`private, max-age=31536000, immutable`, `ETag: "<key>"`). When `k` is
 * missing or stale (the card or a setting changed since the plan was made),
 * the current audio is still served, but as `Cache-Control: no-store` — so a
 * client that kept the old URL around never caches the new bytes under it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const requestedKey = new URL(req.url).searchParams.get('k')
  const fresh = requestedKey === built.key

  return new Response(new Uint8Array(clip.bytes), {
    headers: fresh
      ? {
          'content-type': 'audio/mpeg',
          'cache-control': 'private, max-age=31536000, immutable',
          etag: `"${built.key}"`,
        }
      : {
          'content-type': 'audio/mpeg',
          'cache-control': 'no-store',
        },
  })
}
