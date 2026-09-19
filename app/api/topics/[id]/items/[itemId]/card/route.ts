import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { cardItem } from '@/lib/topics/service'

/** `+ karta` on an open item (spec 2026-09-19-topic-items §4.1). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params
  const result = cardItem(db, id, itemId, new Date())
  return result ? NextResponse.json({ captureId: result.captureId }, { status: 202 }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
