import { clear, createStore, del, entries, set } from 'idb-keyval'

export type OutboxItem = {
  id: string
  bytes: ArrayBuffer
  mime: string
  createdAt: number
  attempts: number
}

const store = createStore('fiszki', 'outbox')
let flushing = false

export async function enqueue(item: Omit<OutboxItem, 'attempts'>): Promise<void> {
  await set(item.id, { ...item, attempts: 0 }, store)
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const rows = await entries<string, OutboxItem>(store)
  return rows.map(([, v]) => v).sort((a, b) => a.createdAt - b.createdAt)
}

export async function clearOutbox(): Promise<void> {
  await clear(store)
  flushing = false
}

/**
 * Uploads everything pending. A failed item is kept forever and its attempt
 * count incremented — losing a dictated word is worse than a stuck queue, so
 * there is deliberately no give-up threshold.
 *
 * Only one flush runs at a time (guarded by `flushing`): a second concurrent
 * call is a no-op that returns `{ sent: [], kept: [] }` immediately, rather
 * than racing the first over the same rows. This is a lock, not a queue —
 * nothing here defers the caller's items to "run again after"; the caller
 * (or the next scheduled flush) simply tries again later. That is safe
 * because a flush that finds nothing new to do is free, and it avoids two
 * concurrent flushes both reading an item, both uploading it, and one of
 * them deleting out from under the other's in-flight upload.
 */
export async function flush(
  upload: (item: OutboxItem) => Promise<void>,
): Promise<{ sent: string[]; kept: string[] }> {
  if (flushing) return { sent: [], kept: [] }
  flushing = true
  const sent: string[] = []
  const kept: string[] = []
  try {
    for (const item of await listOutbox()) {
      try {
        await upload(item)
        await del(item.id, store)
        sent.push(item.id)
      } catch {
        // The upload may have actually succeeded server-side even though we
        // saw a rejection here (e.g. the connection died after the request
        // reached the server but before the response came back). We have no
        // way to tell "genuinely failed" apart from "succeeded but we never
        // heard about it" — and the two outcomes call for opposite actions.
        //
        // We always choose "keep and retry". A spurious retry costs a wasted
        // transcription/generation call and a spare `captures` row, which
        // the pipeline's answerKey duplicate check quietly absorbs into
        // `duplicateOf` rather than a second card. Dropping a genuinely
        // undelivered recording, on the other hand, permanently destroys a
        // word the user just dictated. Given that asymmetry, retrying a
        // maybe-delivered upload is always the correct choice over dropping
        // a maybe-undelivered one — do not "fix" this by giving up on
        // ambiguous failures.
        await set(item.id, { ...item, attempts: item.attempts + 1 }, store)
        kept.push(item.id)
      }
    }
  } finally {
    flushing = false
  }
  return { sent, kept }
}
