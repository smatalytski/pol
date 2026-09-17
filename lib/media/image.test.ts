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

// B5 (test-integrity finding): a flat single-colour fixture compresses to
// ~16KB even unresized, so the 400KB bound below used to pass with `resize`
// deleted entirely — only the sibling width/height assertions were actually
// constraining anything. Real photos have real entropy; noise is a cheap
// stand-in that forces webp's encoder to actually spend bytes per pixel, so
// the size bound only holds if the image was genuinely shrunk first.
async function noisyPng(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3)
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(Math.random() * 256)
  // A blur gives the noise spatial correlation like a real photo's texture,
  // instead of adversarial per-pixel-independent static (which compresses
  // far worse than any real photo and would fail the size bound even with a
  // correct resize in place).
  const buf = await sharp(pixels, { raw: { width, height, channels: 3 } }).blur(3).png().toBuffer()
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
    const out = await toWebp(await noisyPng(3000, 3000), 1280)
    expect(out.bytes.byteLength).toBeLessThan(400_000)
  })

  it('rejects data that is not an image', async () => {
    await expect(toWebp(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})
