import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { discardItem } from '@/lib/topics/service'

/** `✕` on an item in bez karty (spec 2026-09-19-topic-items §4.2). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params
  const ok = discardItem(db, id, itemId, new Date())
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
