import { NextResponse } from 'next/server'
import { getTranscriber, type DictationLang } from '@/lib/transcribe'

/**
 * A dictated topic context, recognised synchronously — the request waits on
 * the transcript and returns it directly. Nothing is stored: the context is
 * not a card, and the user corrects the text before sending it. Russian by
 * default: a context is usually described in Russian, and Speech-to-Text
 * takes exactly one language (DictationLang).
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const file = form.get('audio')
  if (!(file instanceof Blob)) return NextResponse.json({ error: 'audio is required' }, { status: 400 })
  const lang: DictationLang = form.get('lang') === 'pl' ? 'pl' : 'ru'
  try {
    const transcript = await getTranscriber().transcribe({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type || 'audio/webm',
      lang,
    })
    return NextResponse.json({ transcript })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
