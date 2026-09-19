import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { addManualItem } from '@/lib/topics/service'

const Body = z.object({ text: z.string() })

/** `dodaj` on the hand-add bar (spec 2026-09-19-topic-items §4.6). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad item' }, { status: 400 })
  const result = addManualItem(db, id, body.data.text, new Date())
  if (result.ok) return NextResponse.json({ item: result.item }, { status: 201 })
  switch (result.reason) {
    case 'empty':
      return NextResponse.json({ error: 'empty' }, { status: 400 })
    case 'not-found':
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    case 'in-topic':
      return NextResponse.json({ error: 'już jest w tym temacie' }, { status: 409 })
    case 'in-deck':
      return NextResponse.json({ error: `już masz — w temacie ${result.topicName}` }, { status: 409 })
  }
}
