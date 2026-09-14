import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { getGenerator } from '@/lib/generate'
import { processCapture } from '@/lib/capture/pipeline'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await processCapture({ db, transcriber: getTranscriber(), generator: getGenerator() }, id, new Date())
  return NextResponse.json({ ok: true })
}
