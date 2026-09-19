import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { markHeard } from '@/lib/listen/service'

const Body = z.object({ cardId: z.string().trim().min(1) })

/** Records that a card's audio played to its end (spec 2026-09-19-hands-free-audio §4.3). */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad body' }, { status: 400 })
  const ok = markHeard(db, body.data.cardId, new Date())
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return new Response(null, { status: 204 })
}
