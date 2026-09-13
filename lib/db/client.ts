import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema.ts'
import { migrate } from './migrate.ts'

export type Db = BetterSQLite3Database<typeof schema>

const file = process.env.FISZKI_DB ?? 'data/fiszki.db'
mkdirSync(dirname(file), { recursive: true })

export const sqlite = new Database(file)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
migrate(sqlite)

export const db: Db = drizzle(sqlite, { schema })
