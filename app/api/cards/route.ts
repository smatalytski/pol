import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { createCard, searchCards } from '@/lib/cards/service'

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? ''
  return NextResponse.json({ cards: searchCards(db, q) })
}

const Body = z.object({
  type: z.enum(['ru_to_pl']),
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
      examplePl: null,
      exampleRu: null,
      grammarNote: null,
      wordKind: null,
      formsJson: null,
      status: 'ready',
    },
    new Date(),
  )
  return NextResponse.json(result)
}
