import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { createTopic, listTopics } from '@/lib/topics/service'
import { BatchBody } from '@/lib/topics/body'

const Body = BatchBody.extend({ context: z.string().trim().min(1) })

export async function GET() {
  return NextResponse.json({ topics: listTopics(db) })
}

/** Creates a topic and queues its first batch; the batch arrives through the queue (spec 2026-09-19-topic-items §4.5). */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad topic' }, { status: 400 })
  const topicId = createTopic(db, body.data, new Date())
  return NextResponse.json({ topicId }, { status: 201 })
}
