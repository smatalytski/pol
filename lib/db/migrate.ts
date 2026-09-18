import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

const DIR = join(process.cwd(), 'migrations')

/**
 * Reads which migrations are applied and applies every pending one inside a
 * single BEGIN IMMEDIATE transaction, not one transaction per file.
 *
 * `next build` spawns several worker processes, and each imports
 * lib/db/client.ts, which calls this on module load — so against a
 * brand-new, empty database (a fresh deploy per Task 11, or the dev DB
 * dropped per this task's Step 4) more than one process can be migrating at
 * once. Reading `applied` outside a lock let every process see the same
 * empty set and all decide 001-init.sql was pending, so the loser's
 * `CREATE TABLE` failed with "table already exists". BEGIN IMMEDIATE takes
 * SQLite's write lock before the read, so a second process blocks (on the
 * busy_timeout client.ts sets) until the first process's transaction — which
 * applies every pending migration together — commits; it then re-reads
 * `applied` and finds nothing left to do, instead of racing to redo work the
 * first process already finished.
 */
export function migrate(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)

  sqlite
    .transaction(() => {
      const applied = new Set(
        sqlite.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name),
      )
      const pending = readdirSync(DIR).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort()
      for (const name of pending) {
        const sql = readFileSync(join(DIR, name), 'utf8')
        sqlite.exec(sql)
        sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
      }
    })
    .immediate()
}
