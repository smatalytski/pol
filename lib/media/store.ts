import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { media } from '../db/schema'

export type MediaKind = 'image' | 'audio' | 'tts'

/**
 * Duplicate-id semantics (C1/C6): a caller-supplied `id` is normally the
 * random one this function generates itself, but a content-addressed caller
 * — lib/tts/index.ts's clip cache computes `clipId` as a hash of
 * (text, lang, voice) — may legitimately call this twice with the same id
 * for bit-identical content, e.g. two concurrent writers racing to cache the
 * same phrase. That is a benign duplicate, not a bug, so it's tolerated as a
 * no-op (`onConflictDoNothing`) rather than surfacing a thrown UNIQUE
 * constraint error to the caller — the same pattern lib/tts/index.ts already
 * uses for its own `tts_clips` row.
 *
 * No-delete-path semantics: there is deliberately no `deleteMedia` here.
 * Audio, images and TTS clips are kept permanently once stored (spec §4/§9),
 * even after the capture or card referencing them is gone, and no route in
 * this app should add a way to remove one.
 */
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
    .onConflictDoNothing()
    .run()
  return id
}

export function getMedia(db: Db, id: string) {
  const row = db.select().from(media).where(eq(media.id, id)).get()
  return row ?? null
}
