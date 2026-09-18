/**
 * Progressive backoff for retrying generation (spec 2026-09-18-generation-queue
 * §6): 5 s, 10 s, 20 s, … capped at 5 min, with equal jitter so retries after
 * a shared 429 do not all land at once. `random` is injected for tests.
 */
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 300_000

export function backoffMs(attempts: number, random: () => number): number {
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1))
  return Math.round(d / 2 + random() * (d / 2))
}
