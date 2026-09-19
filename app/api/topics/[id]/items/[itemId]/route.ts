import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { moveItem } from '@/lib/topics/service'

const Body = z.object({ topicId: z.string().min(1) })

/** `temat: …` on an item (spec 2026-09-19-topic-items §4.4). */
export async function PATCH(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad patch' }, { status: 400 })
  const ok = moveItem(db, itemId, body.data.topicId)
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
