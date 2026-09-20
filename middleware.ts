import { NextResponse, type NextRequest } from 'next/server'
import {
  IDLE_MS, SESSION_COOKIE, readSessionToken, renewSessionToken, shouldRenew,
} from './lib/auth/session'
import { requireEnv } from './lib/env'

export async function middleware(req: NextRequest) {
  const secret = requireEnv('SESSION_SECRET')
  const now = Date.now()
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const claims = token ? await readSessionToken(secret, token, now) : null
  if (claims) {
    const res = NextResponse.next()
    // Sliding expiry: re-issue once the session is more than half idle-expired,
    // rather than on every request, so an active user is never asked for the
    // password while a cookie that stops being used still lapses on its own.
    // `renewSessionToken` keeps the original issuedAt, so the absolute cap is
    // not pushed out by this.
    if (shouldRenew(claims, now)) {
      res.cookies.set(SESSION_COOKIE, await renewSessionToken(secret, claims, now), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: IDLE_MS / 1000,
      })
    }
    return res
  }
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = req.nextUrl.clone()
  url.pathname = '/logowanie'
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!logowanie$|logowanie/$|api/login$|manifest\\.webmanifest$|sw\\.js$|icons/|_next/).*)',
  ],
}
