import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { acceptRound } from '@/lib/topics/service'
import { RoundBody } from '@/lib/topics/body'

const Body = z.object({ rejected: z.array(z.string()), next: RoundBody.optional() })

/** Accepts a round: struck-out items rejected, the rest queued as cards; `next` asks for another (spec §6.3). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; round: string }> }) {
  const { id, round } = await params
  const n = Number(round)
  const body = Body.safeParse(await req.json())
  if (!Number.isInteger(n) || n < 0 || !body.success) return NextResponse.json({ error: 'bad round' }, { status: 400 })
  const result = acceptRound(db, id, n, body.data.rejected, body.data.next ?? null, new Date())
  return result ? NextResponse.json(result) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
