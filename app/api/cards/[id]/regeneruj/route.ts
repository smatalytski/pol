import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { enqueueJob, hasActiveJob } from '@/lib/queue/jobs'

/**
 * Queues `wygeneruj ponownie` (spec 2026-09-18-generation-queue §5) and answers
 * at once. Gemini is called by the generation queue, which retries 429s with
 * backoff; calling it here would hold this request open for as long as that
 * takes. regenerateCard re-checks needs_input when the job runs.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const card = db.select().from(cards).where(and(eq(cards.id, id), isNull(cards.deletedAt))).get()
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (card.status !== 'needs_input') {
    return NextResponse.json({ error: 'only a needs_input card can be regenerated' }, { status: 400 })
  }
  if (!hasActiveJob(db, id)) enqueueJob(db, { kind: 'regenerate', cardId: id }, new Date())
  return NextResponse.json({ queued: true }, { status: 202 })
}
