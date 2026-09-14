import { desc, eq, gt } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { cards, captures } from '../db/schema'
import { answerKey } from '../cards/answer-key'
import { getMedia, putMedia } from '../media/store'
import { newState } from '../scheduler'
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

  const key = answerKey(fields.answerPl)
  let existing = db.select({ id: cards.id }).from(cards).where(eq(cards.answerKey, key)).get()

  // Best-effort second lookup, success path only: a word that first landed as `needs_input`
  // is keyed by its raw transcript, but a later successful re-dictation is keyed by the
  // diacritic-restored answer_pl, so the primary lookup above would otherwise miss it and
  // silently fork the word into a second card while orphaning the first. This is NOT a
  // guarantee — a differently-mangled second transcript still misses — but a re-dictation is
  // usually mangled the same way the first one was, so it catches the common case at near
  // zero cost. When both keys would match, the generated-answer match above already won,
  // since we only fall through to this check when it found nothing.
  if (!existing && generated) {
    const transcriptKey = answerKey(transcript)
    if (transcriptKey !== key) {
      existing = db.select({ id: cards.id }).from(cards).where(eq(cards.answerKey, transcriptKey)).get()
    }
  }

  if (existing) {
    db.update(captures)
      .set({
        status: 'generated',
        cardId: existing.id,
        generationJson: JSON.stringify({ ...generated, duplicateOf: existing.id }),
        error: generationError,
      })
      .where(eq(captures.id, captureId))
      .run()
    return
  }

  const cardId = randomUUID()
  db.transaction((tx) => {
    tx.insert(cards)
      .values({
        id: cardId,
        type: 'ru_to_pl',
        promptText: fields.promptText,
        promptHint: fields.promptHint,
        promptMediaId: null,
        answerPl: fields.answerPl,
        answerKey: key,
        examplePl: fields.examplePl,
        exampleRu: fields.exampleRu,
        grammarNote: fields.grammarNote,
        status: generated ? 'ready' : 'needs_input',
        parentCardId: null,
        suspendedAt: null,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
        ...newState(now),
      })
      .run()
    tx.update(captures)
      .set({
        status: 'generated',
        cardId,
        generationJson: generated ? JSON.stringify(generated) : null,
        error: generationError,
      })
      .where(eq(captures.id, captureId))
      .run()
  })
}

export function listCaptures(db: Db, since: number): CaptureView[] {
  return db
    .select()
    .from(captures)
    .where(gt(captures.createdAt, since))
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
