import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { recognizeCapture } from '@/lib/capture/pipeline'

/** Retries recognition of a recording whose recognition failed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await recognizeCapture({ db, transcriber: getTranscriber() }, id, new Date())
  return NextResponse.json({ ok: true })
}
