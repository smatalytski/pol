import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { captures } from '@/lib/db/schema'
import { promoteIds } from '@/lib/queue/jobs'

/**
 * Approves one recording now instead of waiting out its review window
 * (spec 2026-09-20 §3.2). The status check is what turns a double tap into a
 * 409 rather than a second card; `promoteIds` guards the same way inside its
 * transaction, so the two together are safe even if the checks interleave.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const row = db.select({ status: captures.status }).from(captures).where(eq(captures.id, id)).get()
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'transcribed') return NextResponse.json({ error: 'not under review' }, { status: 409 })
  promoteIds(db, [id], new Date())
  return NextResponse.json({ ok: true })
}
