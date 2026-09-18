import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { CardTypeError, setCardType } from '@/lib/cards/service'

const Body = z.object({ type: z.enum(['ru_to_pl', 'pl_to_pl']) })

/**
 * Switch a card between recalling it from Russian and drilling its forms. A
 * dedicated route rather than a `type` field on the generic PATCH, because the
 * switch has rules — see setCardType. A CardTypeError is the one refusal
 * expected in normal use and comes back as a 400 with a message; an unknown
 * card propagates like every other route's "no such card" here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'type must be ru_to_pl or pl_to_pl' }, { status: 400 })
  try {
    return NextResponse.json(setCardType(db, id, body.data.type, new Date()))
  } catch (err) {
    if (err instanceof CardTypeError) return NextResponse.json({ error: err.message }, { status: 400 })
    throw err
  }
}
