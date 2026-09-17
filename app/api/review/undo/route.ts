import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { undoLastReview } from '@/lib/review/service'

export async function POST() {
  return NextResponse.json({ undone: undoLastReview(db, new Date()) })
}
