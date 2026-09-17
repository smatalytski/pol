import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { createCard, findDuplicate } from '@/lib/cards/service'
import { getGenerator, toCardFields } from '@/lib/generate'
import { toWebp } from '@/lib/media/image'
import { putMedia } from '@/lib/media/store'

type ImageResult =
  | { name: string; cardId: string; duplicateOf: string | null; answerPl: string }
  | { name: string; error: string }

export async function POST(req: Request) {
  const form = await req.formData()
  const files = form.getAll('images').filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'no images' }, { status: 400 })

  const generator = getGenerator()
  const now = new Date()
  const results: ImageResult[] = []

  // Spec §4: several images are dropped at once. One image's decode or
  // generation failure must not lose the cards already earned by the others
  // in the same batch — hence the per-file try/catch and per-file result,
  // instead of one failure aborting (or 500ing) the whole request.
  for (const file of files) {
    try {
      const image = await toWebp(new Uint8Array(await file.arrayBuffer()))
      const generatedCard = await generator.fromImage({ bytes: image.bytes, mime: image.mime })
      const fields = toCardFields(generatedCard)

      // Check for a duplicate BEFORE storing anything: you can't know whether
      // this photo's Polish name is a duplicate until generation has run, but
      // once you know, storing the media blob for a photo that turns out to
      // duplicate an existing card would orphan it immediately — there is no
      // card to point at it and no delete path for media (lib/media/store.ts
      // is intentionally append-only). So the ordinary "two photos of the same
      // object" case must not touch putMedia at all, not just avoid making a
      // second card.
      const duplicateId = findDuplicate(db, { type: 'image_to_pl', answerPl: fields.answerPl })
      if (duplicateId) {
        results.push({ name: file.name, cardId: duplicateId, duplicateOf: duplicateId, answerPl: fields.answerPl })
        continue
      }

      const promptMediaId = putMedia(db, { kind: 'image', mime: image.mime, bytes: image.bytes, now })
      const { cardId, duplicateOf } = createCard(
        db,
        {
          type: 'image_to_pl',
          promptText: null,
          promptHint: null,
          promptMediaId,
          answerPl: fields.answerPl,
          examplePl: fields.examplePl,
          exampleRu: fields.exampleRu,
          grammarNote: fields.grammarNote,
          status: 'ready',
          parentCardId: null,
        },
        now,
      )
      results.push({ name: file.name, cardId, duplicateOf, answerPl: fields.answerPl })
    } catch (err) {
      results.push({ name: file.name, error: String((err as Error).message ?? err) })
    }
  }

  return NextResponse.json({ results })
}
