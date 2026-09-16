import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, cards } from '../db/schema'
import { createCard } from '../cards/service'
import { answerKey } from '../cards/answer-key'
import { getMedia, putMedia } from '../media/store'
import { toCardFields, type Generator } from '../generate'
import type { Transcriber } from '../transcribe'

export type CaptureDeps = { db: Db; transcriber: Transcriber; generator: Generator }

export type CaptureView = {
  id: string
  status: string
  transcript: string | null
  error: string | null
  cardId: string | null
  duplicateOf: string | null
  audioMediaId: string | null
  createdAt: number
}

export function createCapture(db: Db, audio: { bytes: Uint8Array; mime: string }, now: Date): string {
  const audioMediaId = putMedia(db, { kind: 'audio', mime: audio.mime, bytes: audio.bytes, now })
  const id = randomUUID()
  db.insert(captures)
    .values({
      id,
      audioMediaId,
      transcript: null,
      status: 'uploaded',
      error: null,
      generationJson: null,
      cardId: null,
      createdAt: now.getTime(),
    })
    .run()
  return id
}

/**
 * Transcription and generation are caught separately and on purpose: a dead
 * transcription leaves the capture retryable with its audio intact, while dead
 * generation still yields a card carrying the word.
 */
export async function processCapture(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, transcriber, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture) throw new Error(`no such capture: ${captureId}`)
  if (capture.cardId) return
  if (!capture.audioMediaId) {
    db.update(captures).set({ status: 'failed', error: 'no audio' }).where(eq(captures.id, captureId)).run()
    return
  }

  let transcript = capture.transcript
  if (!transcript) {
    const audio = getMedia(db, capture.audioMediaId)
    if (!audio) {
      db.update(captures).set({ status: 'failed', error: 'audio missing' }).where(eq(captures.id, captureId)).run()
      return
    }
    try {
      transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime })
    } catch (err) {
      // Audio is deliberately retained: the word is recoverable by replay or retry.
      db.update(captures)
        .set({ status: 'failed', error: String((err as Error).message ?? err) })
        .where(eq(captures.id, captureId))
        .run()
      return
    }
    db.update(captures).set({ transcript, status: 'transcribed', error: null }).where(eq(captures.id, captureId)).run()
  }

  let generated = null
  let generationError: string | null = null
  try {
    generated = await generator.fromPolish(transcript)
  } catch (err) {
    generationError = String((err as Error).message ?? err)
  }

  const fields = generated
    ? toCardFields(generated)
    : // Generation is down. Keep the word; the prompt is filled in later by hand.
      { promptText: null, promptHint: null, answerPl: transcript, examplePl: null, exampleRu: null, grammarNote: null }

  // Authorized addition (Task 17 review, critical finding): re-read the
  // capture row immediately before creating a card. `DELETE
  // /api/captures/:id` (spec §4's swipe-to-delete on a chip with no card yet)
  // can land while `generator.fromPolish`, just awaited above, was in
  // flight — and that window is not a corner case: `status` was set to
  // 'transcribed' before this await, so "the transcript just appeared and
  // it's wrong" is exactly when a user is likely to swipe. Without this
  // check, `createCard` below would still run after the capture is gone,
  // producing a live, reviewable card the user has no way to know exists —
  // the chip that would have shown it is already gone, and /dodaj only ever
  // asks the server for captures from the last 60 seconds. Same pattern as
  // the authorized `deleted_at` check in lib/review/queue.ts: a stale read
  // from before an await is never trusted for a decision that creates
  // something durable.
  if (!db.select({ id: captures.id }).from(captures).where(eq(captures.id, captureId)).get()) return

  // Best-effort second key, success path only: a word that first landed as `needs_input`
  // is keyed by its raw transcript, but a later successful re-dictation is keyed by the
  // diacritic-restored answer_pl, so a lookup on answer_pl's key alone would otherwise miss
  // it and silently fork the word into a second card while orphaning the first. This is NOT
  // a guarantee — a differently-mangled second transcript still misses — but a re-dictation
  // is usually mangled the same way the first one was, so it catches the common case at near
  // zero cost. `createCard` only consults this fallback when its primary lookup (on
  // answerKey(fields.answerPl)) finds nothing, so a genuine match on the generated answer
  // always wins.
  const { cardId, duplicateOf } = createCard(
    db,
    {
      type: 'ru_to_pl',
      promptText: fields.promptText,
      promptHint: fields.promptHint,
      promptMediaId: null,
      answerPl: fields.answerPl,
      examplePl: fields.examplePl,
      exampleRu: fields.exampleRu,
      grammarNote: fields.grammarNote,
      status: generated ? 'ready' : 'needs_input',
      parentCardId: null,
      fallbackAnswerKey: generated ? answerKey(transcript) : undefined,
    },
    now,
  )

  // The card-insert (inside createCard, above) and this capture update used to
  // be one db.transaction — extracting createCard into a Db-scoped helper
  // (shared with the non-transactional image route) dropped that atomicity
  // guarantee, with no `tx` handle threaded through. That's safe, not just
  // convenient: if the process dies between the two statements, this capture
  // is left with cardId still null, so a retry re-enters processCapture from
  // the top, calls generator.fromPolish again, and createCard's own primary
  // lookup finds the card just inserted rather than duplicating it — the same
  // path 'retrying a failed capture creates exactly one card' already covers.
  db.update(captures)
    .set({
      status: 'generated',
      cardId,
      generationJson: generated ? JSON.stringify({ ...generated, duplicateOf }) : JSON.stringify({ duplicateOf }),
      error: generationError,
    })
    .where(eq(captures.id, captureId))
    .run()
}

// Important review finding (A4): a swipe-to-delete on a chip with a finished
// card soft-deletes the *card* (DELETE /api/cards/:id), but this list is
// built from `captures`, which is untouched by that — so the chip stayed on
// screen looking undeleted, and the /dodaj screen's `since` is pinned at
// mount, so it would never roll out of the window on its own either. Left-
// join `cards` and drop any capture whose card has been soft-deleted (a
// capture with no card at all, `cardId IS NULL`, is unaffected and always
// kept). The media blob is left alone either way — this only changes what's
// listed, not what's stored.
export function listCaptures(db: Db, since: number): CaptureView[] {
  return db
    .select({
      id: captures.id,
      status: captures.status,
      transcript: captures.transcript,
      error: captures.error,
      cardId: captures.cardId,
      generationJson: captures.generationJson,
      audioMediaId: captures.audioMediaId,
      createdAt: captures.createdAt,
    })
    .from(captures)
    .leftJoin(cards, eq(cards.id, captures.cardId))
    .where(and(gt(captures.createdAt, since), or(isNull(captures.cardId), isNull(cards.deletedAt))))
    .orderBy(desc(captures.createdAt))
    .all()
    .map((c) => ({
      id: c.id,
      status: c.status,
      transcript: c.transcript,
      error: c.error,
      cardId: c.cardId,
      duplicateOf: c.generationJson
        ? ((JSON.parse(c.generationJson) as { duplicateOf?: string }).duplicateOf ?? null)
        : null,
      audioMediaId: c.audioMediaId,
      createdAt: c.createdAt,
    }))
}
