import type { Db } from './db/client'
import { settings } from './db/schema'

const DEFAULTS = {
  newPerDay: 10,
  requestRetention: 0.9,
  audioGapSeconds: 5,
  audioRepeatAnswer: 1,
  audioExample: 1,
  audioHint: 0,
  audioRepeatExample: 1,
  audioNextSeconds: 5,
}
export type Settings = typeof DEFAULTS

// Per-key validity, beyond "is it a finite number". `request_retention` of 0 is
// especially dangerous: ts-fsrs treats it as falsy (`s?.request_retention || T`)
// and silently substitutes its own default of 0.9, so a stored '0' must be
// rejected here rather than passed through as a "valid" number.
const VALIDATORS: { [K in keyof Settings]: (n: number) => boolean } = {
  requestRetention: (n) => n > 0 && n <= 1,
  newPerDay: (n) => Number.isInteger(n) && n >= 0,
  audioGapSeconds: (n) => n >= 0,
  audioRepeatAnswer: (n) => n === 0 || n === 1,
  audioExample: (n) => n === 0 || n === 1,
  audioHint: (n) => n === 0 || n === 1,
  audioRepeatExample: (n) => n === 0 || n === 1,
  audioNextSeconds: (n) => Number.isInteger(n) && n >= 1 && n <= 30,
}

export function getSettings(db: Db): Settings {
  const rows = db.select().from(settings).all()
  const out = { ...DEFAULTS }
  for (const { key, value } of rows) {
    if (!(key in out)) continue
    const k = key as keyof Settings
    const n = Number(value)
    if (Number.isFinite(n) && VALIDATORS[k](n)) out[k] = n
  }
  return out
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}
