import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { topics } from '@/lib/db/schema'
import { enqueueSuggest } from '@/lib/topics/service'
import { BatchBody } from '@/lib/topics/body'
import { DEFAULT_TOPIC_ID } from '@/lib/topics/default'

/**
 * `jeszcze`: queues a batch (spec 2026-09-19-topic-items §4.5), replacing
 * `POST /api/topics/:id/rounds/:round`. 400 for a bad body or the default
 * topic (never generated for); 404 for an unknown topic. `jobId` is null,
 * queueing nothing, while the topic already has a batch in flight.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = BatchBody.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad batch' }, { status: 400 })
  if (!db.select({ id: topics.id }).from(topics).where(eq(topics.id, id)).get()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (id === DEFAULT_TOPIC_ID) return NextResponse.json({ error: 'no batches for the default topic' }, { status: 400 })
  const jobId = enqueueSuggest(db, id, body.data, new Date())
  return NextResponse.json({ jobId }, { status: 202 })
}
