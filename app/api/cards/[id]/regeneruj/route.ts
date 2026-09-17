import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { regenerateCard } from '@/lib/cards/service'
import { GenerationError, getGenerator } from '@/lib/generate'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Same split as the formy route: a GenerationError is the one failure
  // expected in normal operation here — a transient 429 is what stranded the
  // card to begin with — so it gets a status and a message the row can show.
  // Anything else (unknown id, a card that isn't needs_input) is a client or
  // programmer error and keeps propagating as an unhandled 500.
  try {
    return NextResponse.json(await regenerateCard(db, getGenerator(), id, new Date()))
  } catch (err) {
    if (err instanceof GenerationError) {
      return NextResponse.json({ error: err.message }, { status: 502 })
    }
    throw err
  }
}
