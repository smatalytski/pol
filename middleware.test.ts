import { describe, expect, it } from 'vitest'
import { config } from './middleware'

// Next compiles a matcher source string into a regex effectively anchored as
// `^<source>$` and tests it against the request pathname. We replicate that
// here so this test exercises the exact pattern shipped in `config.matcher`,
// not a hand-rolled approximation of it.
const matcherRegex = new RegExp(`^${config.matcher[0]}$`)

const mustBeGuarded = [
  '/',
  '/powtorki',
  '/dodaj',
  '/fiszki',
  '/obrazki',
  '/ustawienia',
  '/api/review/queue',
  '/api/cards',
  '/api/logowanie',
  '/logowanie-fake',
  '/api/login-admin',
  '/swXjs',
]

const mustBeExcluded = [
  '/logowanie',
  '/api/login',
  '/manifest.webmanifest',
  '/sw.js',
  '/icons/x.png',
  '/_next/static/y.js',
]

describe('middleware matcher', () => {
  it.each(mustBeGuarded)('matches (is guarded by) %s', (path) => {
    expect(matcherRegex.test(path)).toBe(true)
  })

  it.each(mustBeExcluded)('does not match (is excluded from) %s', (path) => {
    expect(matcherRegex.test(path)).toBe(false)
  })
})
