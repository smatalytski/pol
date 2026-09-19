import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { restoreCard } from '@/lib/cards/service'

/** `przywróć` on a soft-deleted card in odrzucone (spec 2026-09-19-topic-items §4.3). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = restoreCard(db, id, new Date())
  if (result.ok) return NextResponse.json({ card: result.card })
  if (result.reason === 'not-found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ error: `już masz — w temacie ${result.topicName}` }, { status: 409 })
}
