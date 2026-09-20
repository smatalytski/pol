/**
 * The login throttle. Pure: no database, no clock, so the route and its tests
 * share one definition of "blocked" and it can be checked at its exact edges.
 *
 * The budget is **global**, not per-IP. There is one legitimate user, so a
 * per-IP counter buys almost nothing — an attacker rotating addresses gets a
 * full allowance from each one — while a single shared counter caps the total
 * guess rate no matter where the attempts come from. The price is that
 * someone hammering the endpoint also makes the owner wait, which is why the
 * penalty is capped (`MAX_DELAY_MS`) rather than escalating without limit:
 * the worst an attacker can impose is a few minutes, not a lockout.
 */

/** Consecutive failures allowed before any penalty — room for ordinary typos. */
export const FREE_ATTEMPTS = 5
/** The first penalty, doubling with each further failure. */
export const BASE_DELAY_MS = 60_000
/** The ceiling, so a flood of attempts cannot lock the owner out for long. */
export const MAX_DELAY_MS = 300_000

export type ThrottleState = {
  /** Consecutive failures since the last success. */
  failures: number
  /** Epoch ms until which attempts are refused, or null when nothing is owed. */
  blockedUntil: number | null
}

/** How long a failure count costs: nothing inside the allowance, then 1m, 2m, 4m… capped. */
export function penaltyMs(failures: number): number {
  const over = failures - FREE_ATTEMPTS
  if (over <= 0) return 0
  return Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS)
}

/**
 * Milliseconds the caller must wait, or null if the attempt may proceed.
 * The boundary is inclusive of expiry: at exactly `blockedUntil` the block is
 * over, so a penalty of N ms costs N ms and not a tick more.
 */
export function retryAfterMs(state: ThrottleState, now: number): number | null {
  if (state.blockedUntil === null || now >= state.blockedUntil) return null
  return state.blockedUntil - now
}

/** Count a wrong password and, past the allowance, start or extend the block. */
export function afterFailure(state: ThrottleState, now: number): ThrottleState {
  const failures = state.failures + 1
  const penalty = penaltyMs(failures)
  return { failures, blockedUntil: penalty === 0 ? null : now + penalty }
}

/** A correct password clears the budget — an owner who gets in is not still serving a penalty. */
export function afterSuccess(): ThrottleState {
  return { failures: 0, blockedUntil: null }
}
