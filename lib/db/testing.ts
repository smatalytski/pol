import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { migrate } from './migrate'
import type { Db } from './client'

export function createTestDb(): { db: Db; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  return { db: drizzle(sqlite, { schema }), sqlite }
}
