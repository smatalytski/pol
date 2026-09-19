import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { planSession } from '@/lib/listen/service'

const Body = z.object({
  minutes: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(45)]),
  topicIds: z.array(z.string()).optional(),
  excludeIds: z.array(z.string()).optional(),
})

/** Plans a listening session (spec 2026-09-19-hands-free-audio §4.1). */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad body' }, { status: 400 })
  const cards = planSession(db, body.data, new Date())
  return NextResponse.json({ cards })
}
