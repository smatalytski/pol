import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { restoreItem } from '@/lib/topics/service'

/** `przywróć` on an item in odrzucone (spec 2026-09-19-topic-items §4.3). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params
  const ok = restoreItem(db, id, itemId)
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
