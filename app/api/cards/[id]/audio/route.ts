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
  return NextResponse.redirect(new URL(`/api/media/${mediaId}`, req.url), 307)
}
