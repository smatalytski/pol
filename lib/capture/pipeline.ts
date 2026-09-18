import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client'
import { captures, cards } from '../db/schema'
import { applyGeneratedFields, createCard, regenerateCard, type GeneratedFields } from '../cards/service'
import { answerKey } from '../cards/answer-key'
import { getMedia, putMedia } from '../media/store'
import { toCardFields, type Generator } from '../generate'
import type { DictationLang, Transcriber } from '../transcribe'
import { enqueueJob, hasQueuedJobFor, underReview, type JobHandlers } from '../queue/jobs'
import { approvedIds, reviewRemainingMs } from '../queue/review'

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

const CYRILLIC = /[Ѐ-ӿ]/

/**
 * `już masz` at recognition time (spec 2026-09-18-generation-queue §4). Checks
 * the raw transcript against live ru_to_pl cards — new dictations are always
 * ru_to_pl, and dedup is type-scoped. Best-effort by design: a card is keyed by
 * its generated answer, so a transcript that lost a diacritic misses here, and
 * createCard's dedup at generation time stays as the backstop.
 */
export function knownCardFor(db: Db, transcript: string): string | null {
  const key = answerKey(transcript)
  if (!key) return null
  const live = and(eq(cards.type, 'ru_to_pl'), isNull(cards.deletedAt))
  if (!CYRILLIC.test(transcript)) {
    return db.select({ id: cards.id }).from(cards).where(and(live, eq(cards.answerKey, key))).get()?.id ?? null
  }
  // The Russian prompt is stored raw, not keyed, so keys are compared in JS —
  // the same personal-scale trade-off as searchCards.
  const match = db
    .select({ id: cards.id, promptText: cards.promptText })
    .from(cards)
    .where(and(live, isNotNull(cards.promptText)))
    .all()
    .find((c) => answerKey(c.promptText!) === key)
  return match?.id ?? null
}

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
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime })
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
 * Re-recognises a recording's stored audio in the language the user names.
 * Speech-to-Text stays synchronous (fast, its own quota). Under review, the
 * transcript is replaced and the 10 s restarts (§3). With a card, or with a
 * `new` job already generating, the Gemini half is queued as a `rerecognized`
 * job (§5); `queued` in the result says the Gemini half is waiting in the queue.
 *
 * This exists because language detection is not safe here. Measured on the
 * real API: with `['pl-PL','ru-RU']` the Polish model swallows Russian whole —
 * spoken "склеп" came back "sklep", "час" came back "czas", "бешенство" came
 * back "wściekłość" — in both code orders, while a single language code was
 * correct on every word in both languages. So dictation stays Polish, which is
 * what nearly all of it is, and a Russian recording is repaired afterwards.
 *
 * It has to work from the audio. A wrong-language transcript keeps no trace of
 * what was actually said, so `regenerateCard` — which re-generates from the
 * stored answer — would faithfully reproduce the same mistake. The audio is
 * kept permanently anyway (spec §4/§9), which is what makes this possible at
 * all. For the same reason a pending `regenerate` job on the card does not
 * stand in for a `rerecognized` one: only the latter reads the new transcript.
 */
export async function rerecognize(
  deps: RecognizeDeps,
  captureId: string,
  lang: DictationLang,
): Promise<{ queued: boolean; error: string | null }> {
  const { db, transcriber, clock } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture) throw new Error(`no such capture: ${captureId}`)
  const audio = capture.audioMediaId ? getMedia(db, capture.audioMediaId) : null
  if (!audio) {
    db.update(captures).set({ error: 'audio missing' }).where(eq(captures.id, captureId)).run()
    return { queued: false, error: 'audio missing' }
  }
  let transcript: string
  try {
    transcript = await transcriber.transcribe({ bytes: audio.bytes, mime: audio.mime, lang })
  } catch (err) {
    // The previous transcript and card are deliberately left standing, so the
    // control can simply be pressed again.
    const message = String((err as Error).message ?? err)
    db.update(captures).set({ error: message }).where(eq(captures.id, captureId)).run()
    return { queued: false, error: message }
  }
  // Read after Speech-to-Text returned: promotion may have moved the
  // recording on while it ran, and the restarted window starts now (§3).
  const now = clock()
  const still = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!still) return { queued: false, error: null }
  const setTranscript = (patch: Partial<typeof captures.$inferInsert> = {}) =>
    db.update(captures).set({ transcript, error: null, ...patch }).where(eq(captures.id, captureId)).run()

  if (still.cardId) {
    setTranscript()
    // A card the user deleted stays deleted: nothing is rebuilt for it.
    if (!liveCard(db, still.cardId)) return { queued: false, error: null }
    queueRerecognized(db, captureId, still.cardId, now)
    return { queued: true, error: null }
  }
  if (still.status === 'generating') {
    // Its `new` job is mid-Gemini on the old transcript. A `rerecognized` job
    // runs after it (the worker is serial) and reads the recording's card at
    // run time, so it rebuilds the card that job made — or, if it runs first
    // because that job failed and is retrying, makes the card itself, and the
    // `new` job then only marks the recording generated.
    setTranscript()
    queueRerecognized(db, captureId, null, now)
    return { queued: true, error: null }
  }
  if (still.status === 'queued') {
    // Its `new` job is waiting (first try or a retry) and reads the transcript
    // when it runs, so only the text changes.
    setTranscript()
    return { queued: true, error: null }
  }
  // Under review, promoted as już masz, or its first recognition failed: back
  // into review with a fresh 10 s, and już masz decided again for the new
  // word. Still 'uploaded' (its first recognition has not landed): only the
  // text changes.
  const reopen = still.status === 'transcribed' || still.status === 'duplicate' || still.status === 'failed'
  setTranscript({
    duplicateOf: knownCardFor(db, transcript),
    ...(reopen ? { status: 'transcribed' as const, transcribedAt: now.getTime() } : {}),
  })
  return { queued: false, error: null }
}

/**
 * A queued `rerecognized` job reads the transcript when it runs, so it
 * already covers a newer one. A running one has already read the old
 * transcript: a successor is queued, which runs after it and wins.
 */
function queueRerecognized(db: Db, captureId: string, cardId: string | null, now: Date): void {
  if (!hasQueuedJobFor(db, 'rerecognized', captureId)) {
    enqueueJob(db, { kind: 'rerecognized', captureId, cardId }, now)
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

/** Job `new`: an approved recording becomes a card. A generation failure is thrown for the queue to classify. */
export async function generateNewCard(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || !capture.transcript) return
  if (capture.cardId) {
    // The card was created but the process died before the job was marked
    // done, so the job ran again. Finish what that run was doing, or the
    // recording would stay pending forever.
    db.update(captures).set({ status: 'generated' }).where(eq(captures.id, captureId)).run()
    return
  }
  const transcript = capture.transcript
  const generated = await generator.fromDictation(transcript)
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
    { type: 'ru_to_pl', ...fields, status: 'ready', fallbackAnswerKey: answerKey(transcript) },
    now,
  )
  // Not one transaction with the insert above: if the process dies between
  // them, the job runs again, and createCard's lookup finds the card just
  // inserted rather than duplicating it.
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ ...generated, duplicateOf }), error: null })
    .where(eq(captures.id, captureId))
    .run()
}

/** Job `new` gave up: the word is kept as a needs_input card (§6). */
export function giveUpNewCard(db: Db, captureId: string, lastError: string, now: Date): void {
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture || capture.cardId || !capture.transcript) return
  const { cardId, duplicateOf } = createCard(
    db,
    { type: 'ru_to_pl', ...strandedFields(capture.transcript), status: 'needs_input' },
    now,
  )
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ duplicateOf }), error: lastError })
    .where(eq(captures.id, captureId))
    .run()
}

/**
 * Job `rerecognized`: rebuilds a card from its recording's new transcript. It
 * rewrites the card in place only when this recording created it (see
 * creatorCaptureId), and on a clash leaves it untouched; otherwise the
 * recording goes through createCard like a new dictation. A card the user
 * deleted is never rebuilt or replaced, not even when it was deleted while
 * Gemini ran.
 */
export async function applyRerecognized(deps: CaptureDeps, captureId: string, now: Date): Promise<void> {
  const { db, generator } = deps
  const capture = db.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!capture?.transcript) return
  if (capture.cardId && !liveCard(db, capture.cardId)) return
  const transcript = capture.transcript
  const generated = await generator.fromDictation(transcript)
  const fields = toCardFields(generated)
  const still = db.select({ cardId: captures.cardId }).from(captures).where(eq(captures.id, captureId)).get()
  if (!still) return
  if (still.cardId && !liveCard(db, still.cardId)) return
  const existing =
    still.cardId && creatorCaptureId(db, still.cardId) === captureId ? liveCard(db, still.cardId) : undefined
  const { cardId, duplicateOf } = existing
    ? (({ card, duplicateOf }) => ({ cardId: card.id, duplicateOf }))(
        applyGeneratedFields(db, existing, fields, now, { onClash: 'untouched' }),
      )
    : createCard(db, { type: 'ru_to_pl', ...fields, status: 'ready', fallbackAnswerKey: answerKey(transcript) }, now)
  db.update(captures)
    .set({ status: 'generated', cardId, generationJson: JSON.stringify({ ...generated, duplicateOf }), error: null })
    .where(eq(captures.id, captureId))
    .run()
}

/** Job `rerecognized` gave up: the card stays as it was; the failure is recorded (§6). */
export function giveUpRerecognized(db: Db, captureId: string, lastError: string): void {
  db.update(captures).set({ error: lastError }).where(eq(captures.id, captureId)).run()
}

/** The three job kinds (§5), wired to their bodies. */
export function jobHandlers(deps: CaptureDeps): JobHandlers {
  return {
    new: {
      run: (job, now) => generateNewCard(deps, job.captureId!, now),
      giveUp: (job, lastError, now) => giveUpNewCard(deps.db, job.captureId!, lastError, now),
    },
    rerecognized: {
      run: (job, now) => applyRerecognized(deps, job.captureId!, now),
      giveUp: (job, lastError) => giveUpRerecognized(deps.db, job.captureId!, lastError),
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
  }
}

/**
 * The capture whose recording created a card: the earliest capture with audio
 * that points at it. Dedup means several captures can point at one card — a
 * duplicate dictation resolves to the card it matched — and only the earliest
 * one's recording actually made it. One rule for everything that needs to
 * know: `GET /api/cards/:id` offers re-recognition of this capture's audio,
 * and `applyRerecognized` rewrites a card in place only for this capture.
 */
export function creatorCaptureId(db: Db, cardId: string): string | null {
  const row = db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.cardId, cardId), isNotNull(captures.audioMediaId)))
    .orderBy(asc(captures.createdAt))
    .get()
  return row?.id ?? null
}
