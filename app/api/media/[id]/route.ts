import { db } from '@/lib/db/client'
import { getMedia } from '@/lib/media/store'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const row = getMedia(db, id)
  if (!row) return new Response('not found', { status: 404 })

  const etag = `"${id}"`
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 })

  return new Response(new Uint8Array(row.bytes), {
    headers: {
      'content-type': row.mime,
      'content-length': String(row.byteSize),
      // Media is content-immutable: a media id never points at different bytes.
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    },
  })
}
