import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, requireEnv, verifySessionToken } from './lib/auth/session'

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token && (await verifySessionToken(requireEnv('SESSION_SECRET'), token, new Date()))) {
    return NextResponse.next()
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
