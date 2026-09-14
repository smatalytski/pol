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

  const text = part === 'answer' ? card.answerPl : card.promptText
  if (!text) return NextResponse.json({ error: 'nothing to speak' }, { status: 404 })

  const mediaId = await getClip(db, getSynthesizer(), text, part === 'answer' ? 'pl' : 'ru', new Date())
  return NextResponse.redirect(new URL(`/api/media/${mediaId}`, req.url), 307)
}
