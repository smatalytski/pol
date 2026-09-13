import { NextResponse } from 'next/server'
import { SESSION_COOKIE, constantTimeEqual, createSessionToken } from '@/lib/auth/session'
import { requireEnv } from '@/lib/env'

export async function POST(req: Request) {
  const { password } = (await req.json()) as { password?: string }
  if (!password || !constantTimeEqual(password, requireEnv('APP_PASSWORD'))) {
    return NextResponse.json({ error: 'bad-password' }, { status: 401 })
  }
  const token = await createSessionToken(requireEnv('SESSION_SECRET'), new Date())
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  })
  return res
}
