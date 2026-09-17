'use client'
import { useRef, useState } from 'react'
import type { CaptureView } from '@/lib/capture/pipeline'
import type { DictationLang } from '@/lib/transcribe'
import { t } from '@/i18n/pl'

/**
 * A chip renders one of two things: a recording that has no server row yet
 * (still sitting in the local outbox, possibly stuck retrying an upload), or
 * a capture the server already knows about. These are deliberately kept as
 * one discriminated union rather than two components so the merged list in
 * `app/dodaj/page.tsx` can render both from a single `.map`.
 *
 * `outbox:${id}` / `capture:${id}` keys (assigned by the caller via
 * `chipKey`) come from two disjoint id spaces — the outbox id is generated
 * client-side by `crypto.randomUUID()` in `onRecorded` and is never sent to
 * the server, while the capture id is generated server-side in
 * `createCapture`. An outbox item is deleted from the local store at the
 * same point the matching server row already exists (`outbox.ts`'s `flush`
 * awaits the upload, which only resolves after `createCapture` has run,
 * before it deletes the item), so there is at most one poll cycle where both
 * a `outbox:` chip and the `capture:` chip for the same word are visible at
 * once. That brief overlap is expected and self-corrects on the next poll;
 * nothing here tries to eagerly suppress it, since doing so would require
 * correlating the two unrelated id spaces.
 */
export type ChipItem =
  | { kind: 'outbox'; id: string; createdAt: number }
  | { kind: 'capture'; capture: CaptureView }

export function chipKey(item: ChipItem): string {
  return item.kind === 'outbox' ? `outbox:${item.id}` : `capture:${item.capture.id}`
}

export function chipCreatedAt(item: ChipItem): number {
  return item.kind === 'outbox' ? item.createdAt : item.capture.createdAt
}

// Horizontal distance (px) a pointer must travel before a release counts as a
// swipe rather than a tap. Chosen the same way the recording gesture's 300ms
// tap threshold was: large enough that an ordinary tap (a few px of finger
// wobble) never fires it, small enough that a deliberate swipe on a phone
// screen clears it easily.
const SWIPE_THRESHOLD_PX = 60

type EditableFields = {
  promptText: string | null
  promptHint: string | null
  answerPl: string
  examplePl: string | null
  exampleRu: string | null
  grammarNote: string | null
}

export function CaptureChip({
  item,
  onRetry,
  onDelete,
  onRelanguage,
}: {
  item: ChipItem
  onRetry: (id: string) => void
  onRelanguage: (id: string, lang: DictationLang) => void
  onDelete: (item: ChipItem) => void
}) {
  // Hooks must run unconditionally, before the outbox early return below —
  // an outbox chip never uses this state, but React doesn't allow a
  // conditional hook count between renders of the same component.
  //
  // A ref, not state, for the gesture's start position: it is pure bookkeeping
  // between one pointerdown and the pointerup that follows it, never itself
  // drives what's rendered, and — unlike state — is written and read
  // synchronously with no render in between, so back-to-back pointerdown/
  // pointerup handlers (as a real swipe fires, and as a test firing both
  // events in one `act()` batch does too) always see the value the other one
  // just set. Same pattern as hooks/useHoldToRecord.ts's gesture refs.
  const pointerStartX = useRef<number | null>(null)
  const [fields, setFields] = useState<EditableFields | null>(null)
  const [saveError, setSaveError] = useState(false)

  if (item.kind === 'outbox') {
    // No server row exists yet for this recording, so there is no id to
    // replay audio against or to retry — rendering those controls anyway
    // would offer buttons that can't work (the mistake Task 11's
    // audio-eligibility fix corrected for cards). Spec §11: an upload stuck
    // retrying still gets its own per-word chip rather than only showing up
    // as an ambient count, so it's never unclear which word is stuck. Spec
    // §4's swipe-to-delete/tap-to-edit affordances are for a *capture* the
    // server already knows about (see task 17's decision: "no cardId means
    // nothing to soft-delete", not "no server row at all") — an outbox item
    // isn't one, so this branch stays exactly as Task 15 shipped it.
    return (
      <li className="flex items-center gap-3 border-b py-3">
        <p className="flex-1 text-lg text-neutral-500">{t.uploading}</p>
      </li>
    )
  }

  const capture = item.capture
  const expanded = fields !== null

  async function loadFields() {
    if (!capture.cardId) return
    const res = await fetch(`/api/cards/${capture.cardId}`)
    if (!res.ok) return
    const { card } = (await res.json()) as { card: EditableFields }
    setFields({
      promptText: card.promptText,
      promptHint: card.promptHint,
      answerPl: card.answerPl,
      examplePl: card.examplePl,
      exampleRu: card.exampleRu,
      grammarNote: card.grammarNote,
    })
  }

  function onPointerDown(e: React.PointerEvent) {
    pointerStartX.current = e.clientX
  }

  function onPointerUp(e: React.PointerEvent) {
    if (pointerStartX.current === null) return
    const dx = e.clientX - pointerStartX.current
    pointerStartX.current = null
    if (dx <= -SWIPE_THRESHOLD_PX) {
      onDelete(item)
      return
    }
    // Anything short of a real swipe is treated as a tap. Editing only makes
    // sense once a card exists — a capture still uploading/transcribing/
    // failed has nothing to edit yet, so tapping it does nothing.
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX && capture.cardId) {
      if (expanded) {
        setFields(null)
      } else {
        void loadFields()
      }
    }
  }

  function updateField<K extends keyof EditableFields>(key: K, value: EditableFields[K]) {
    setFields((f) => (f ? { ...f, [key]: value } : f))
  }

  async function save() {
    if (!fields || !capture.cardId) return
    const res = await fetch(`/api/cards/${capture.cardId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    })
    if (!res.ok) {
      setSaveError(true)
      return
    }
    setSaveError(false)
    setFields(null)
  }

  return (
    <li
      className="flex flex-col gap-2 border-b py-3"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-lg">{capture.transcript ?? t.transcribing}</p>
          {capture.duplicateOf && <p className="text-sm text-amber-600">{t.alreadyHave}</p>}
          {/* Shown whenever there is an error, not only when the status is
              'failed': a transient Vertex 429 leaves a capture 'generated'
              WITH an error and a stranded card, which is how a card ends up
              needing repair with nothing on screen saying why. A failed
              re-recognition lands the same way. */}
          {capture.error && <p className="text-sm text-red-600">{capture.error}</p>}
        </div>
        {/* Pressing ▶ or "ponów" is itself a pointerdown+pointerup pair that
            would otherwise bubble to the `<li>` and register as a tap or a
            swipe on top of whatever the control itself does. */}
        {capture.audioMediaId && (
          <audio
            controls
            preload="none"
            src={`/api/media/${capture.audioMediaId}`}
            aria-label={t.play}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          />
        )}
        {capture.status === 'failed' && (
          <button
            onClick={() => onRetry(capture.id)}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            className="text-sm underline"
          >
            {t.retry}
          </button>
        )}
      </div>

      {/* Dictation is recognised as Polish, because that is what nearly all of
          it is: measured on the real API, a two-language recognizer swallows
          Russian whole (spoken "склеп" came back "sklep"). So a Russian
          recording is repaired here instead, from the stored audio — the wrong
          transcript keeps no trace of what was actually said, which is why
          regenerating from the card could never fix it. Both directions are
          offered rather than a toggle, so a mistaken re-recognition is undone
          the same way it was made. Each control stops its own pointer events,
          or the <li> would read the press as a tap or a swipe as well. */}
      {capture.audioMediaId && (
        <div className="flex items-center gap-3 pl-2 text-sm">
          <span className="text-neutral-500">{t.recognizeAs}</span>
          {([
            ['pl', t.asPolish],
            ['ru', t.asRussian],
          ] as const).map(([lang, label]) => (
            <button
              key={lang}
              onClick={() => onRelanguage(capture.id, lang)}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              className="underline"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {expanded && fields && (
        // Stops the same bubbling the controls above guard against: tapping
        // into a field to edit it is itself a pointerdown+pointerup pair, and
        // without this the `<li>`'s own handler would read that as "tap while
        // expanded" and collapse the form the instant the user tries to type.
        <div
          className="flex flex-col gap-2 pl-2"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <input
            value={fields.answerPl}
            onChange={(e) => updateField('answerPl', e.target.value)}
            className="rounded border p-2 text-lg"
          />
          <input
            value={fields.promptText ?? ''}
            onChange={(e) => updateField('promptText', e.target.value || null)}
            className="rounded border p-2 text-sm"
          />
          <input
            value={fields.promptHint ?? ''}
            onChange={(e) => updateField('promptHint', e.target.value || null)}
            className="rounded border p-2 text-sm"
          />
          <button onClick={() => void save()} className="self-start text-sm underline">
            {t.save}
          </button>
          {saveError && <p className="text-sm text-red-600">{t.chipSaveFailed}</p>}
        </div>
      )}
    </li>
  )
}
