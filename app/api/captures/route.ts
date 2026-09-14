import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { getGenerator } from '@/lib/generate'
import { createCapture, listCaptures, processCapture } from '@/lib/capture/pipeline'

export async function POST(req: Request) {
  const form = await req.formData()
  const file = form.get('audio')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'audio is required' }, { status: 400 })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = createCapture(db, { bytes, mime: file.type || 'audio/webm' }, new Date())

  // Deliberately not awaited: the phone is told "stored" the moment the bytes
  // are durable, and transcription happens behind it. Safe because this runs as
  // a long-lived Node server; a serverless host would kill the work mid-flight.
  void processCapture({ db, transcriber: getTranscriber(), generator: getGenerator() }, id, new Date()).catch(
    (err) => console.error('capture pipeline failed', id, err),
  )

  return NextResponse.json({ captureId: id }, { status: 202 })
}

export async function GET(req: Request) {
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0)
  return NextResponse.json({ captures: listCaptures(db, Number.isFinite(since) ? since : 0) })
}
