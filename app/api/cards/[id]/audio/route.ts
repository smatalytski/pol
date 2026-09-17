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

  // Card type decides both eligibility and language — promptText is a
  // Russian gloss for ru_to_pl but a Polish form request for pl_forms
  // (spec §8), and pl_forms' answer is a Markdown declension table that
  // spec §6 says must never be read aloud. Deriving this from `part` alone
  // would send Polish text to the Russian voice, or read a table aloud, and
  // because the clip cache is content-addressed, a wrong clip made that way
  // could never be displaced by a later fix.
  const lang: 'pl' | 'ru' | null =
    part === 'prompt'
      ? card.type === 'ru_to_pl'
        ? 'ru'
        : null
      : card.type === 'ru_to_pl' || card.type === 'image_to_pl'
        ? 'pl'
        : null
  if (!lang) return NextResponse.json({ error: 'nothing to speak' }, { status: 404 })

  const text = part === 'answer' ? card.answerPl : card.promptText
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
