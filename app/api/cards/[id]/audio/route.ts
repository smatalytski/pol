import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { getClip, getSynthesizer } from '@/lib/tts'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const part = new URL(req.url).searchParams.get('part') ?? 'answer'
  if (part !== 'answer' && part !== 'prompt') {
    return NextResponse.json({ error: 'part must be answer or prompt' }, { status: 400 })
  }

  const card = db.select().from(cards).where(eq(cards.id, id)).get()
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Only a ru_to_pl card has a Russian prompt. A pl_to_pl card's prompt IS the
  // Polish word, so its prompt is spoken from answer_pl in the Polish voice
  // (spec 2026-09-18 §8). Forms are never spoken. Deriving the voice from
  // `part` alone would send Polish text to the Russian voice, and because the
  // clip cache is content-addressed, a wrong clip made that way could never be
  // displaced by a later fix.
  const russianPrompt = part === 'prompt' && card.type === 'ru_to_pl'
  const lang: 'pl' | 'ru' = russianPrompt ? 'ru' : 'pl'
  const text = russianPrompt ? card.promptText : card.answerPl
  if (!text) return NextResponse.json({ error: 'nothing to speak' }, { status: 404 })

  const mediaId = await getClip(db, getSynthesizer(), text, lang, new Date())
  // A RELATIVE Location (RFC 7231 7.1.2), deliberately. The browser resolves
  // it against the URL it actually requested, which is the only origin that is
  // reachable from the browser's side. NextResponse.redirect requires an
  // absolute URL, and the only origin available here is `req.url` — which
  // behind a reverse proxy (`tailscale serve`, or any ingress) is
  // http://localhost:3000, the app's own internal bind address. Sending that
  // as Location tells the BROWSER to fetch its own localhost:3000, so the
  // <audio> element fails silently and the card just never plays. Trusting a
  // forwarded host header instead would work but adds a spoofable input for
  // no gain: this redirect never needs to leave the current origin.
  return new Response(null, { status: 307, headers: { location: `/api/media/${mediaId}` } })
}
