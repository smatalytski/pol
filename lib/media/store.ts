import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { media } from '../db/schema'

export type MediaKind = 'image' | 'audio' | 'tts'

export function putMedia(
  db: Db,
  input: { kind: MediaKind; mime: string; bytes: Uint8Array; id?: string; now?: Date },
): string {
  const id = input.id ?? randomUUID()
  const buf = Buffer.from(input.bytes)
  db.insert(media)
    .values({
      id,
      kind: input.kind,
      mime: input.mime,
      bytes: buf,
      byteSize: buf.byteLength,
      createdAt: (input.now ?? new Date()).getTime(),
    })
    .run()
  return id
}

export function getMedia(db: Db, id: string) {
  const row = db.select().from(media).where(eq(media.id, id)).get()
  return row ?? null
}
