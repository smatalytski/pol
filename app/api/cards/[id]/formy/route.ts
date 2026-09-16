import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { createFormsCard } from '@/lib/cards/service'
import { getGenerator } from '@/lib/generate'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json(await createFormsCard(db, getGenerator(), id, new Date()))
}
