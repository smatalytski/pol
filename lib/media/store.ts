import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { media } from '../db/schema'

export type MediaKind = 'audio' | 'tts'

/**
 * Duplicate-id semantics (C1/C6): neither current caller (lib/tts/index.ts,
 * lib/capture/pipeline.ts) pass an explicit `id` today — each gets a fresh
 * `randomUUID()` below, so a duplicate `media.id` cannot occur in the app as
 * it stands. `id` is still accepted, and a collision tolerated as a no-op
 * (`onConflictDoNothing`)
 * rather than a thrown UNIQUE constraint error, purely defensively: it's the
 * obvious shape for a future content-addressed caller (e.g. if
 * lib/tts/index.ts's clip cache — which already content-addresses its own
 * `tts_clips.id` via `clipId`, independently of `media.id` — were extended to
 * content-address the underlying media row too, so two concurrent writers
 * caching the same phrase could race here harmlessly, the way they already
 * do on `tts_clips`). The trade-off that defensiveness buys: a future caller
 * that reused an id with genuinely *different* bytes would get a silent
 * no-op (the first writer's row wins) rather than an error surfacing the
 * mistake — acceptable only because "same id, different content" should be
 * impossible for a real content hash, never because it's been verified safe
 * for a caller that doesn't exist yet.
 *
 * No-delete-path semantics: there is deliberately no `deleteMedia` here.
 * Audio and TTS clips are kept permanently once stored (spec §4/§9),
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
