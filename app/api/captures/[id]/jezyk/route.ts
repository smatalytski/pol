import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { getTranscriber } from '@/lib/transcribe'
import { getGenerator } from '@/lib/generate'
import { retranscribe } from '@/lib/capture/pipeline'

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

  // Both providers' failures are already caught inside retranscribe and come
  // back in `error` — the capture keeps its old transcript and card, so this
  // is a 200 carrying bad news, not a failed request.
  return NextResponse.json(
    await retranscribe(
      { db, transcriber: getTranscriber(), generator: getGenerator() },
      id,
      body.data.lang,
      new Date(),
    ),
  )
}
