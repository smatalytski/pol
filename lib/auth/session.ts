export const SESSION_COOKIE = 'fiszki_session'

/**
 * Two clocks bound a session, because they answer different questions.
 *
 * `IDLE_MS` is how long a session survives without being used: the cookie is
 * re-issued as you browse (see `shouldRenew`), so ordinary use never asks for
 * the password, while a cookie that stops being used dies on its own.
 *
 * `ABSOLUTE_MS` is the ceiling no amount of use can push past, measured from
 * the original login. Without it, sliding renewal means a stolen cookie that
 * is kept warm lives forever.
 *
 * Both are enforced in `readSessionToken`, from values inside the signed
 * payload — a forged `issuedAt` fails the signature, so the cap cannot be
 * moved by the holder.
 */
export const IDLE_MS = 30 * 24 * 60 * 60 * 1000
export const ABSOLUTE_MS = 365 * 24 * 60 * 60 * 1000
const enc = new TextEncoder()

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

function toBase64Url(bytes: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(secret: string, payload: string): Promise<string> {
  return toBase64Url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)))
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  // Fold the length difference into the result instead of returning early,
  // so a wrong-length guess costs the same as a wrong-content one.
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export type SessionClaims = {
  /** When the password was last entered. The absolute cap is measured from here. */
  issuedAt: number
  /** When the session lapses if it is not used again before then. */
  expiresAt: number
}

/** Signs a pair of timestamps into a token. Both `createSessionToken` and `renewSessionToken` go through here. */
export async function mintSessionToken(secret: string, issuedAt: number, expiresAt: number): Promise<string> {
  const payload = `${issuedAt}.${expiresAt}`
  return `${payload}.${await sign(secret, payload)}`
}

export async function createSessionToken(secret: string, now: Date, ttlMs = IDLE_MS): Promise<string> {
  return mintSessionToken(secret, now.getTime(), now.getTime() + ttlMs)
}

/**
 * The claims of a token that is validly signed and live on both clocks, or
 * null. A token from before the payload gained `issuedAt` has two parts
 * rather than three and fails here, so the format change logs everyone out
 * once rather than leaving uncapped sessions in circulation.
 */
export async function readSessionToken(secret: string, token: string, now: Date | number): Promise<SessionClaims | null> {
  const t = typeof now === 'number' ? now : now.getTime()
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [issuedRaw, expiresRaw, signature] = parts
  if (!issuedRaw || !expiresRaw || !signature) return null
  const issuedAt = Number(issuedRaw)
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null
  if (t >= expiresAt) return null
  if (t >= issuedAt + ABSOLUTE_MS) return null
  if (!constantTimeEqual(signature, await sign(secret, `${issuedRaw}.${expiresRaw}`))) return null
  return { issuedAt, expiresAt }
}

export async function verifySessionToken(secret: string, token: string, now: Date): Promise<boolean> {
  return (await readSessionToken(secret, token, now)) !== null
}

/** Re-issue once a session is more than half idle-expired, so an active user is never interrupted. */
export function shouldRenew(claims: SessionClaims, now: number): boolean {
  if (now >= claims.issuedAt + ABSOLUTE_MS) return false
  return claims.expiresAt - now < IDLE_MS / 2
}

/** Extends the idle window, keeping the original `issuedAt` so the absolute cap still bites. */
export async function renewSessionToken(secret: string, claims: SessionClaims, now: number): Promise<string> {
  const expiresAt = Math.min(now + IDLE_MS, claims.issuedAt + ABSOLUTE_MS)
  return mintSessionToken(secret, claims.issuedAt, expiresAt)
}
