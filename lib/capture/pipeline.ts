import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, cards, topicItems, topics } from '../db/schema'
import { createCard, knownCardFor, regenerateCard, type GeneratedFields } from '../cards/service'
import { answerKey } from '../cards/answer-key'
import { getMedia, putMedia } from '../media/store'
import { toCardFields, type Generator, type Meaning, type Suggester } from '../generate'
import type { DictationLang, Transcriber } from '../transcribe'
import { underReview, type JobHandlers } from '../queue/jobs'
import { approvedIds, reviewRemainingMs } from '../queue/review'
import { runSuggest } from '../topics/service'

export type CaptureDeps = { db: Db; transcriber: Transcriber; generator: Generator }

export type CaptureView = {
  id: string
  status: string
  transcript: string | null
  error: string | null
  duplicateOf: string | null
  createdAt: number
  /** Transcribed and not yet approved: rejectable, with the bar running (§3). */
  inReview: boolean
  /** Server-computed, so the phone's clock cannot distort the bar. Null when not under review. */
  reviewRemainingMs: number | null
}

export function createCapture(
  db: Db,
  audio: { bytes: Uint8Array; mime: string },
  now: Date,
  lang: DictationLang = 'pl',
  topicId: string | null = null,
): string {
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
      lang,
      topicId,
    })
    .run()
  return id
}

/** The fields a failed generation leaves behind: keep the word, lose the rest. */
function strandedFields(transcript: string): GeneratedFields {
  return {
    promptText: null,
    promptHint: null,
    answerPl: transcript,
    examplePl: null,
    exampleRu: null,
    grammarNote: null,
    wordKind: null,
    formsJson: null,
  }
}

/**
 * `clock` rather than a `now` argument: the review window starts when the
 * transcript arrives (§3), which is only known after Speech-to-Text returns,
 * so the time is read then. Routes pass `() => new Date()`; tests a fake.
 */
export type RecognizeDeps = { db: Db; transcriber: Transcriber; clock: () => Date }

/**
 * Recognises an uploaded (or failed) recording and opens its review window.
 * Makes no Gemini call: generation is queued once the recording is approved.
 */
export async function recognizeCapture(deps: RecognizeDeps, captureId: string): Promise<void> {
  const { db, transcriber, clock } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture) throw new Error(`no such capture: ${captureId}`)
  if (capture.status !== 'uploaded' && capture.status !== 'failed') return
  const audio = capture.audioMediaId ? getMedia(db, capture.audioMediaId) : null
  if (!audio) {
    db.update(captures)
      .set({ status: 'failed', error: capture.audioMediaId ? 'audio missing' : 'no audio' })
      .where(eq(captures.id, captureId))
      .run()
    return
  }
  let transcript: string
  try {
    // The language is the button the recording was made with (spec
    // 2026-09-18-recording-language §2); a recording from before that has
    // none and was always recognised as Polish.
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime, lang: capture.lang ?? 'pl' })
  } catch (err) {
    // Audio is deliberately retained: the word is recoverable by retrying.
    db.update(captures)
      .set({ status: 'failed', error: String((err as Error).message ?? err) })
      .where(eq(captures.id, captureId))
      .run()
    return
  }
  // The recording may have been rejected while Speech-to-Text ran; an update
  // of a deleted row is a no-op, so no re-read is needed.
  db.update(captures)
    .set({
      transcript,
      status: 'transcribed',
      transcribedAt: clock().getTime(),
      duplicateOf: knownCardFor(db, transcript),
      error: null,
    })
    .where(eq(captures.id, captureId))
    .run()
}

/**
 * At worker startup: a recording still 'uploaded' lost the recognition its
 * request started when the server restarted (a deploy is a restart), and
 * would otherwise wait at rozpoznawanie… forever. Recognises each one again,
 * oldest first and one at a time; an error is logged and the rest still run.
 */
export async function recognizeStranded(deps: RecognizeDeps): Promise<void> {
  const ids = deps.db
    .select({ id: captures.id })
    .from(captures)
    .where(eq(captures.status, 'uploaded'))
    .orderBy(asc(captures.createdAt))
    .all()
    .map((r) => r.id)
  for (const id of ids) {
    try {
      await recognizeCapture(deps, id)
    } catch (err) {
      console.error('stranded capture recognition failed', id, err)
    }
  }
}

function liveCard(db: Db, cardId: string) {
  return db.select().from(cards).where(and(eq(cards.id, cardId), isNull(cards.deletedAt))).get()
}

/**
 * What the recording screen shows (§7.1): uploaded, failed-recognition and
 * still-under-review recordings within `since`. An approved recording drops
 * out of this list at the moment it is approved — one rule, evaluated here and
 * in the worker.
 */
export function listOnScreen(db: Db, since: number, now: Date): CaptureView[] {
  const t = now.getTime()
  const review = new Map(underReview(db).map((r) => [r.id, r]))
  const approved = approvedIds([...review.values()], t)
  return db
    .select({
      id: captures.id,
      status: captures.status,
      transcript: captures.transcript,
      error: captures.error,
      duplicateOf: captures.duplicateOf,
      createdAt: captures.createdAt,
    })
    .from(captures)
    .where(and(gt(captures.createdAt, since), inArray(captures.status, ['uploaded', 'transcribed', 'failed'])))
    .orderBy(desc(captures.createdAt))
    .all()
    .filter((c) => c.status !== 'transcribed' || (review.has(c.id) && !approved.has(c.id)))
    .map((c) => {
      const r = c.status === 'transcribed' ? review.get(c.id)! : null
      return { ...c, inReview: r !== null, reviewRemainingMs: r ? reviewRemainingMs(r, t) : null }
    })
}

/** Recordings approved and waiting for, or in, generation (§7.2). */
export function pendingCaptures(db: Db): { id: string; transcript: string | null; status: 'queued' | 'generating' }[] {
  return db
    .select({ id: captures.id, transcript: captures.transcript, status: captures.status })
    .from(captures)
    .where(inArray(captures.status, ['queued', 'generating']))
    .orderBy(desc(captures.createdAt))
    .all() as { id: string; transcript: string | null; status: 'queued' | 'generating' }[]
}

/** A topic item's intended sense and situation; undefined when there is neither (spec 2026-09-19-topic-items §4.1). */
function meaningOf(db: Db, capture: { topicId: string | null; glossRu: string | null }): Meaning | undefined {
  if (!capture.topicId) return undefined
  const topic = db.select({ context: topics.context }).from(topics).where(eq(topics.id, capture.topicId)).get()
  const context = topic?.context.trim() ? topic.context : null
  const glossRu = capture.glossRu?.trim() ? capture.glossRu : null
  return glossRu || context ? { glossRu, context } : undefined
}

/** A `+ karta` item (spec 2026-09-19-topic-items §4.1) learns which card it became. */
function linkItem(db: Db, captureId: string, cardId: string): void {
  db.update(topicItems).set({ cardId }).where(eq(topicItems.captureId, captureId)).run()
}

/** Job `new`: an approved recording, or a topic item sent with `+ karta`, becomes a card. A generation failure is thrown for the queue to classify. */
export async function generateNewCard(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || !capture.transcript) return
  if (capture.cardId) {
    // The card was created but the process died before the job was marked
    // done, so the job ran again. Finish what that run was doing, or the
    // recording would stay pending forever (and its item unlinked).
    db.update(captures).set({ status: 'generated' }).where(eq(captures.id, captureId)).run()
    linkItem(db, captureId, capture.cardId)
    return
  }
  const transcript = capture.transcript
  const meaning = meaningOf(db, capture)
  // Called with the transcript alone for a dictation, exactly as before, and
  // for a gloss-less item of a topic with no context (Ogólne).
  const generated = meaning ? await generator.fromDictation(transcript, meaning) : await generator.fromDictation(transcript)
  const fields = toCardFields(generated)
  // A stale read from before the await is never trusted for a decision that
  // creates something durable: the recording may have been deleted meanwhile.
  if (!db.select({ id: captures.id }).from(captures).where(eq(captures.id, captureId)).get()) return
  // Best-effort second key: a word that first landed as `needs_input` is keyed
  // by its raw transcript, but this card is keyed by the diacritic-restored
  // answer_pl, so a lookup on answer_pl's key alone would miss it and fork the
  // word into a second card. `createCard` only consults this fallback when its
  // primary lookup finds nothing, so a genuine match on the generated answer
  // always wins.
  const { cardId, duplicateOf } = createCard(
    db,
    { type: 'ru_to_pl', ...fields, status: 'ready', fallbackAnswerKey: answerKey(transcript), topicId: capture.topicId },
    now,
  )
  // Not one transaction with the insert above: if the process dies between
  // them, the job runs again, and createCard's lookup finds the card just
  // inserted rather than duplicating it.
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ ...generated, duplicateOf }), error: null })
    .where(eq(captures.id, captureId))
    .run()
  linkItem(db, captureId, cardId)
}

/** Job `new` gave up: the word is kept as a needs_input card (§6). */
export function giveUpNewCard(db: Db, captureId: string, lastError: string, now: Date): void {
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || capture.cardId || !capture.transcript) return
  const { cardId, duplicateOf } = createCard(
    db,
    { type: 'ru_to_pl', ...strandedFields(capture.transcript), status: 'needs_input', topicId: capture.topicId },
    now,
  )
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ duplicateOf }), error: lastError })
    .where(eq(captures.id, captureId))
    .run()
  linkItem(db, captureId, cardId)
}

/** The three job kinds, wired to their bodies. */
export function jobHandlers(deps: CaptureDeps & { suggester: Suggester }): JobHandlers {
  return {
    new: {
      run: (job, now) => generateNewCard(deps, job.captureId!, now),
      giveUp: (job, lastError, now) => giveUpNewCard(deps.db, job.captureId!, lastError, now),
    },
    // keepAnswer, approved by the user; a card that stays needs_input on give-up is repairable again.
    regenerate: {
      run: async (job, now) => {
        // Deleted or already repaired since it was queued: nothing to do.
        // regenerateCard would throw, which the queue counts as a failure.
        const card = liveCard(deps.db, job.cardId!)
        if (card?.status !== 'needs_input') return
        await regenerateCard(deps.db, deps.generator, job.cardId!, now)
      },
      giveUp: () => {},
    },
    // No give-up action: the job's `failed` status and last_error are the
    // record, and the topic page offers `spróbuj ponownie` (§6.1).
    suggest: {
      run: (job, now) => runSuggest({ db: deps.db, suggester: deps.suggester }, job, now),
      giveUp: () => {},
    },
  }
}
