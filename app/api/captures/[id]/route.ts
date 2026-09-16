import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { captures } from '@/lib/db/schema'

/**
 * Not in the task brief's literal file list. Spec §4's chip affordances need
 * a way to remove a capture that has no card yet (still uploaded/transcribed/
 * failed) when the user swipes its chip away — `lib/capture/pipeline.ts` is a
 * frozen module for this task, so this route talks to the `captures` table
 * directly rather than adding a delete helper there, mirroring how
 * app/api/cards/[id]/audio/route.ts already reads `cards` directly instead of
 * going through lib/cards/service.ts for a lookup with no side effects.
 *
 * Deliberately does not touch `media`: audio is kept permanently per spec §4
 * even when its capture row is gone (lib/media/store.ts's `putMedia` doc
 * comment spells out the no-delete-path-by-design decision), and this route
 * does not add one.
 * A no-op (200) on an unknown id, like the cards DELETE route, since deleting
 * something already gone is not an error.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  db.delete(captures).where(eq(captures.id, id)).run()
  return NextResponse.json({ ok: true })
}
