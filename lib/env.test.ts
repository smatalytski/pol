import { afterEach, describe, expect, it } from 'vitest'
import { requireEnv } from './env'

const KEY = 'FISZKI_TEST_REQUIRE_ENV'

afterEach(() => {
  delete process.env[KEY]
})

describe('requireEnv', () => {
  it('returns the value when the variable is set', () => {
    process.env[KEY] = 'value'
    expect(requireEnv(KEY)).toBe('value')
  })

  it('throws a named error when the variable is unset or empty', () => {
    delete process.env[KEY]
    expect(() => requireEnv(KEY)).toThrow(/FISZKI_TEST_REQUIRE_ENV is not set/)
    process.env[KEY] = ''
    expect(() => requireEnv(KEY)).toThrow(/FISZKI_TEST_REQUIRE_ENV is not set/)
  })
})
