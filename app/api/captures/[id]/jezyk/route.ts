import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { rerecognize } from '@/lib/capture/pipeline'

const Body = z.object({ lang: z.enum(['pl', 'ru']) })

/**
 * Recognise this capture's stored audio again, in a language the user names.
 *
 * Only the two languages the app knows are accepted — never a free-form code.
 * Sending an unknown one straight through to Speech-to-Text would either fail
 * deep in the provider or, worse, succeed and produce a card in a language
 * nothing else here can render.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = Body.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: 'lang must be pl or ru' }, { status: 400 })

  // Speech-to-Text failures come back in `error` as a 200 — the recording
  // keeps its transcript. With a card, `queued` says the Gemini half is now
  // waiting in the generation queue.
  return NextResponse.json(await rerecognize({ db, transcriber: getTranscriber() }, id, body.data.lang, new Date()))
}
