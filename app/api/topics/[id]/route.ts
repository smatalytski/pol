import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { topicView, updateTopic } from '@/lib/topics/service'

const Patch = z.object({
  name: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  suspendedAt: z.number().int().nullable().optional(),
})

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const view = topicView(db, (await params).id)
  return view ? NextResponse.json(view) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const patch = Patch.safeParse(await req.json())
  if (!patch.success) return NextResponse.json({ error: 'bad patch' }, { status: 400 })
  const topic = updateTopic(db, id, patch.data)
  return topic ? NextResponse.json({ topic }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
