import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { topicView, updateTopic } from '@/lib/topics/service'
import { DEFAULT_TOPIC_ID } from '@/lib/topics/default'

const Patch = z.object({
  name: z.string().trim().min(1).optional(),
  context: z.string().trim().min(1).optional(),
  suspendedAt: z.number().int().nullable().optional(),
})

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const view = topicView(db, (await params).id)
  return view ? NextResponse.json(view) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

/** The default topic cannot be renamed or given a context (spec 2026-09-19-topic-items §3.2). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const patch = Patch.safeParse(await req.json())
  if (!patch.success) return NextResponse.json({ error: 'bad patch' }, { status: 400 })
  if (id === DEFAULT_TOPIC_ID && (patch.data.name !== undefined || patch.data.context !== undefined)) {
    return NextResponse.json({ error: 'the default topic cannot be renamed or given a context' }, { status: 400 })
  }
  const topic = updateTopic(db, id, patch.data)
  return topic ? NextResponse.json({ topic }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
