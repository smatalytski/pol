export const SESSION_COOKIE = 'fiszki_session'
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const enc = new TextEncoder()

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

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

export async function createSessionToken(secret: string, now: Date, ttlMs = YEAR_MS): Promise<string> {
  const expiresAt = String(now.getTime() + ttlMs)
  return `${expiresAt}.${await sign(secret, expiresAt)}`
}

export async function verifySessionToken(secret: string, token: string, now: Date): Promise<boolean> {
  const [expiresAt, signature] = token.split('.')
  if (!expiresAt || !signature) return false
  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return false
  return constantTimeEqual(signature, await sign(secret, expiresAt))
}
