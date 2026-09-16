import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { toWebp } from './image'

async function png(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('toWebp', () => {
  it('shrinks the long edge to the limit and keeps the aspect ratio', async () => {
    const out = await toWebp(await png(2400, 1200), 1280)
    expect(out.width).toBe(1280)
    expect(out.height).toBe(640)
    expect(out.mime).toBe('image/webp')
  })

  it('does not enlarge a small image', async () => {
    const out = await toWebp(await png(400, 300), 1280)
    expect(out.width).toBe(400)
    expect(out.height).toBe(300)
  })

  it('produces a row small enough to sit comfortably in SQLite', async () => {
    const out = await toWebp(await png(3000, 3000), 1280)
    expect(out.bytes.byteLength).toBeLessThan(400_000)
  })

  it('rejects data that is not an image', async () => {
    await expect(toWebp(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})
