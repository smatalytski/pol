import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { topics } from '@/lib/db/schema'
import { getTranscriber, type DictationLang } from '@/lib/transcribe'
import { createCapture, listOnScreen, recognizeCapture } from '@/lib/capture/pipeline'

export async function POST(req: Request) {
  const form = await req.formData()
  const file = form.get('audio')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'audio is required' }, { status: 400 })
  }
  // Chosen by the button held on /dodaj. Absent from an outbox entry saved
  // before the language existed, which was a Polish recording.
  const langField = form.get('lang')
  if (langField !== null && langField !== 'pl' && langField !== 'ru') {
    return NextResponse.json({ error: 'lang must be pl or ru' }, { status: 400 })
  }
  const lang: DictationLang = langField ?? 'pl'
  // A sheet left open across a topic's lifetime must not silently misfile a
  // word, so an unknown id is refused rather than dropped to Ogólne.
  const topicField = form.get('topicId')
  let topicId: string | null = null
  if (typeof topicField === 'string' && topicField !== '') {
    const known = db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicField)).get()
    if (!known) return NextResponse.json({ error: 'unknown topic' }, { status: 400 })
    topicId = topicField
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = createCapture(db, { bytes, mime: file.type || 'audio/webm' }, new Date(), lang, topicId)

  // Deliberately not awaited: the phone is told "stored" the moment the bytes
  // are durable, and recognition happens behind it. Generation is not started
  // here at all: it is queued once the recording leaves review. Safe because
  // this runs as a long-lived Node server; a serverless host would kill the
  // work mid-flight.
  void recognizeCapture({ db, transcriber: getTranscriber(), clock: () => new Date() }, id).catch((err) =>
    console.error('capture recognition failed', id, err),
  )

  return NextResponse.json({ captureId: id }, { status: 202 })
}

export async function GET(req: Request) {
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0)
  return NextResponse.json({ captures: listOnScreen(db, Number.isFinite(since) ? since : 0, new Date()) })
}
