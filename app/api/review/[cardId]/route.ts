import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { recordReview } from '@/lib/review/service'

const Body = z.object({
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  durationMs: z.number().int().nonnegative().nullable(),
})

export async function POST(req: Request, { params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad rating' }, { status: 400 })
  const next = recordReview(db, cardId, body.data.rating, body.data.durationMs, new Date())
  return NextResponse.json({ due: next.due })
}
