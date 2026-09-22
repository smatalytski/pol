import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearOutbox, enqueue, flush, listOutbox } from './outbox'

const item = (id: string) => ({ id, bytes: new Uint8Array([1, 2, 3]).buffer, mime: 'audio/webm', createdAt: 1, lang: 'pl' as const })

beforeEach(async () => {
  await clearOutbox()
})

describe('outbox', () => {
  it('persists an enqueued recording', async () => {
    await enqueue(item('a'))
    const all = await listOutbox()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('a')
    expect(new Uint8Array(all[0].bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(all[0].attempts).toBe(0)
  })

  it('uploads and then removes each item', async () => {
    await enqueue(item('a'))
    await enqueue(item('b'))
    const upload = vi.fn().mockResolvedValue(undefined)
    const { sent, kept } = await flush(upload)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(sent.sort()).toEqual(['a', 'b'])
    expect(kept).toEqual([])
    expect(await listOutbox()).toEqual([])
  })

  it('KEEPS an item whose upload failed and counts the attempt', async () => {
    await enqueue(item('a'))
    const { sent, kept } = await flush(vi.fn().mockRejectedValue(new Error('offline')))
    expect(sent).toEqual([])
    expect(kept).toEqual(['a'])
    const all = await listOutbox()
    expect(all).toHaveLength(1)
    expect(all[0].attempts).toBe(1)
  })

  it('never drops an item, however many times it fails', async () => {
    await enqueue(item('a'))
    const failing = vi.fn().mockRejectedValue(new Error('offline'))
    for (let i = 0; i < 20; i++) await flush(failing)
    const all = await listOutbox()
    expect(all).toHaveLength(1)
    expect(all[0].attempts).toBe(20)
  })

  it('sends a previously failed item once the network returns', async () => {
    await enqueue(item('a'))
    await flush(vi.fn().mockRejectedValue(new Error('offline')))
    const { sent } = await flush(vi.fn().mockResolvedValue(undefined))
    expect(sent).toEqual(['a'])
    expect(await listOutbox()).toEqual([])
  })

  it('does not upload the same item twice when flushed concurrently', async () => {
    await enqueue(item('a'))
    let resolve!: () => void
    const upload = vi.fn(() => new Promise<void>((r) => { resolve = () => r() }))
    const first = flush(upload)
    const second = await flush(upload)
    // `second` resolves after a single microtask (it short-circuits on the
    // `flushing` guard with no I/O), but `first`'s `listOutbox()` read goes
    // through fake-indexeddb, which dispatches request completion via
    // `setImmediate` (a macrotask) to faithfully emulate real IndexedDB
    // event timing. So `second` settling is not proof that `first` has
    // reached its `upload` call yet — wait for that explicitly, rather than
    // calling `resolve()` immediately, which races and throws
    // "resolve is not a function" before `upload` has been invoked.
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    resolve()
    await first
    expect(upload).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ sent: [], kept: [] })
  })

  it('is a no-op when empty', async () => {
    expect(await flush(vi.fn())).toEqual({ sent: [], kept: [] })
  })

  it('attempts every item even when one fails, and accounts for all of them', async () => {
    await enqueue(item('a'))
    await enqueue(item('b'))
    await enqueue(item('c'))
    const upload = vi.fn(async (i: { id: string }) => {
      if (i.id === 'b') throw new Error('offline')
    })
    const { sent, kept } = await flush(upload)
    expect(upload).toHaveBeenCalledTimes(3)
    // Every item enqueued must be accounted for in exactly one of the two lists.
    expect([...sent, ...kept].sort()).toEqual(['a', 'b', 'c'])
    expect(kept).toEqual(['b'])
    expect(sent.sort()).toEqual(['a', 'c'])
  })

  it('round-trips boundary byte values unchanged through IndexedDB', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer
    await enqueue({ id: 'a', bytes, mime: 'audio/webm', createdAt: 1, lang: 'pl' })
    const all = await listOutbox()
    expect([...new Uint8Array(all[0].bytes)]).toEqual([0, 1, 2, 253, 254, 255])
  })

  it('keeps the language of a recording through the outbox', async () => {
    await enqueue({ id: 'a', bytes: new ArrayBuffer(1), mime: 'audio/webm', createdAt: 1, lang: 'ru' })
    expect((await listOutbox())[0].lang).toBe('ru')
  })

  it('keeps a recording’s topic while it waits offline', async () => {
    await enqueue({ id: 'o1', bytes: new ArrayBuffer(2), mime: 'audio/webm', createdAt: 1, lang: 'pl', topicId: 't1' })
    expect((await listOutbox())[0].topicId).toBe('t1')
  })
})
