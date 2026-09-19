import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { retrySuggest } from '@/lib/topics/service'

/** `spróbuj ponownie`: the failed batch again. jobId is null when there was nothing to retry. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return NextResponse.json({ jobId: retrySuggest(db, (await params).id, new Date()) })
}
