import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { getSettings, setSetting } from '@/lib/settings'

export async function GET() {
  return NextResponse.json(getSettings(db))
}

const Body = z.object({
  newPerDay: z.number().int().min(0).max(200).optional(),
  requestRetention: z.number().min(0.7).max(0.98).optional(),
  audioGapSeconds: z.number().int().min(1).max(30).optional(),
  audioRepeatAnswer: z.union([z.literal(0), z.literal(1)]).optional(),
  audioExample: z.union([z.literal(0), z.literal(1)]).optional(),
  audioHint: z.union([z.literal(0), z.literal(1)]).optional(),
  audioRepeatExample: z.union([z.literal(0), z.literal(1)]).optional(),
})

export async function PUT(req: Request) {
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'bad settings' }, { status: 400 })
  for (const [key, value] of Object.entries(body.data)) setSetting(db, key, String(value))
  return NextResponse.json(getSettings(db))
}
