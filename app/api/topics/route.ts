import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { createTopic, listTopics } from '@/lib/topics/service'
import { RoundBody } from '@/lib/topics/body'

const Body = RoundBody.extend({ context: z.string().trim().min(1) })

export async function GET() {
  return NextResponse.json({ topics: listTopics(db) })
}

/** Creates a topic and queues its first round; the round arrives through the queue (spec §6). */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad topic' }, { status: 400 })
  // The request body has no level yet — the UI doesn't offer one (spec §4.5,
  // task 2 adds it). Temporary until that call site changes.
  const topicId = createTopic(db, { ...body.data, level: 'zaawansowany' }, new Date())
  return NextResponse.json({ topicId }, { status: 201 })
}
