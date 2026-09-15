import type { CaptureView } from '@/lib/capture/pipeline'
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

export function CaptureChip({ item, onRetry }: { item: ChipItem; onRetry: (id: string) => void }) {
  if (item.kind === 'outbox') {
    // No server row exists yet for this recording, so there is no id to
    // replay audio against or to retry — rendering those controls anyway
    // would offer buttons that can't work (the mistake Task 11's
    // audio-eligibility fix corrected for cards). Spec §11: an upload stuck
    // retrying still gets its own per-word chip rather than only showing up
    // as an ambient count, so it's never unclear which word is stuck.
    return (
      <li className="flex items-center gap-3 border-b py-3">
        <p className="flex-1 text-lg text-neutral-500">{t.uploading}</p>
      </li>
    )
  }

  const capture = item.capture
  return (
    <li className="flex items-center gap-3 border-b py-3">
      <div className="flex-1">
        <p className="text-lg">{capture.transcript ?? t.transcribing}</p>
        {capture.duplicateOf && <p className="text-sm text-amber-600">{t.alreadyHave}</p>}
        {capture.status === 'failed' && <p className="text-sm text-red-600">{capture.error}</p>}
      </div>
      {capture.audioMediaId && (
        <audio controls preload="none" src={`/api/media/${capture.audioMediaId}`} aria-label={t.play} />
      )}
      {capture.status === 'failed' && (
        <button onClick={() => onRetry(capture.id)} className="text-sm underline">
          {t.retry}
        </button>
      )}
    </li>
  )
}
