import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { cards } from '@/lib/db/schema'
import { deleteCard, updateCard } from '@/lib/cards/service'
import { creatorCaptureId } from '@/lib/capture/pipeline'
import { hasActiveJob } from '@/lib/queue/jobs'

const Patch = z.object({
  promptText: z.string().nullable().optional(),
  promptHint: z.string().nullable().optional(),
  answerPl: z.string().min(1).optional(),
  examplePl: z.string().nullable().optional(),
  exampleRu: z.string().nullable().optional(),
  grammarNote: z.string().nullable().optional(),
  suspendedAt: z.number().int().nullable().optional(),
})

/**
 * Not in the task brief's literal file list — added because
 * `components/CaptureChip.tsx`'s "tap to expand and edit" needs a way to load
 * a specific card's current fields before editing them, and there was no
 * existing single-card lookup route (`GET /api/cards` only searches/lists).
 * Excludes a soft-deleted card the same way every other listing query does.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), isNull(cards.deletedAt)))
    .get()
  if (!card) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // The capture whose recording produced this card, so the detail screen can
  // offer "recognise this again in Russian" — and only offer it when there is
  // audio to re-recognise, rather than showing a control that must fail.
  // Earliest, not latest: see creatorCaptureId, which applyRerecognized uses too.
  // Re-recognising a later duplicate's audio would not rewrite this card at
  // all — it would go through createCard instead, producing a new card (or,
  // via dedup, resolving to an existing one). `generating` tells the page a
  // queued job will rewrite this card, so it can show that as not-yet-final.
  return NextResponse.json({ card, captureId: creatorCaptureId(db, id), generating: hasActiveJob(db, id) })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const patch = Patch.safeParse(await req.json())
  if (!patch.success) return NextResponse.json({ error: 'bad patch' }, { status: 400 })
  return NextResponse.json({ card: updateCard(db, id, patch.data, new Date()) })
}

// Soft delete (decided 2026-09-16): sets `deleted_at` via `deleteCard` rather
// than removing the row, so `reviews` survives. `deleteCard` takes an
// injected `now` (a deviation from the brief's `deleteCard(db, id): void` —
// see lib/cards/service.ts for why).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  deleteCard(db, id, new Date())
  return NextResponse.json({ ok: true })
}
