import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { SESSION_COOKIE, constantTimeEqual, createSessionToken } from '@/lib/auth/session'
import { afterFailure, afterSuccess, retryAfterMs, type ThrottleState } from '@/lib/auth/throttle'
import { db } from '@/lib/db/client'
import { loginThrottle } from '@/lib/db/schema'
import { requireEnv } from '@/lib/env'

const EMPTY: ThrottleState = { failures: 0, blockedUntil: null }

function readThrottle(): ThrottleState {
  const row = db.select().from(loginThrottle).where(eq(loginThrottle.id, 1)).get()
  return row ? { failures: row.failures, blockedUntil: row.blockedUntil } : EMPTY
}

/** Upsert rather than update: the seeded row is expected, but a missing one must not silently disable the throttle. */
function writeThrottle(state: ThrottleState) {
  db.insert(loginThrottle)
    .values({ id: 1, failures: state.failures, blockedUntil: state.blockedUntil })
    .onConflictDoUpdate({
      target: loginThrottle.id,
      set: { failures: state.failures, blockedUntil: state.blockedUntil },
    })
    .run()
}

/**
 * The only unauthenticated endpoint (see `middleware.ts`'s matcher), and since
 * the app left its tailnet for the public internet it is the only thing
 * between a stranger and the deck — so it is rate limited (lib/auth/throttle.ts).
 *
 * The throttle is checked *before* the password is compared, not only after a
 * failure. Otherwise the gate is decorative: an attacker who happens to guess
 * correctly on attempt 400 is let straight in, having been "blocked" for the
 * 399 before it. The cost is that the owner cannot log in during a penalty
 * either, which is why the penalty is capped at a few minutes.
 */
export async function POST(req: Request) {
  const now = Date.now()
  const state = readThrottle()

  const wait = retryAfterMs(state, now)
  if (wait !== null) {
    // The refused attempt is not counted: a blocked caller must not be able to
    // push their own penalty higher by retrying, or an attacker could ratchet
    // the owner's wait up to the cap and hold it there.
    return NextResponse.json(
      { error: 'too-many-attempts' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(wait / 1000)) } },
    )
  }

  const { password } = (await req.json()) as { password?: string }
  if (!password || !constantTimeEqual(password, requireEnv('APP_PASSWORD'))) {
    writeThrottle(afterFailure(state, now))
    return NextResponse.json({ error: 'bad-password' }, { status: 401 })
  }

  writeThrottle(afterSuccess())
  const token = await createSessionToken(requireEnv('SESSION_SECRET'), new Date(now))
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
