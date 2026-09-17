import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { createCard, searchCards } from '@/lib/cards/service'

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? ''
  return NextResponse.json({ cards: searchCards(db, q) })
}

// Minor review finding: this route hardcodes parentCardId: null, so
// 'pl_forms' is deliberately excluded here — a pl_forms card created through
// it would have no origin, contrary to spec §3 ("a pl_forms card records its
// origin in parent_card_id"). The only path to a pl_forms card is
// POST /api/cards/:id/formy.
const Body = z.object({
  type: z.enum(['ru_to_pl', 'image_to_pl']),
  promptText: z.string().nullable(),
  promptHint: z.string().nullable(),
  answerPl: z.string().min(1),
})

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad card' }, { status: 400 })
  const result = createCard(
    db,
    {
      ...body.data,
      promptMediaId: null,
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      status: 'ready',
      parentCardId: null,
    },
    new Date(),
  )
  return NextResponse.json(result)
}
