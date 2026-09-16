import sharp from 'sharp'

export async function toWebp(
  input: Uint8Array,
  maxEdge = 1280,
): Promise<{ bytes: Uint8Array; mime: 'image/webp'; width: number; height: number }> {
  const { data, info } = await sharp(input)
    .rotate() // honour EXIF orientation before resizing
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true })
  return { bytes: new Uint8Array(data), mime: 'image/webp', width: info.width, height: info.height }
}
