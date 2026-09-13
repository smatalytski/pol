import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

const DIR = join(process.cwd(), 'migrations')

export function migrate(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name),
  )
  const pending = readdirSync(DIR).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort()
  for (const name of pending) {
    const sql = readFileSync(join(DIR, name), 'utf8')
    sqlite.transaction(() => {
      sqlite.exec(sql)
      sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now())
    })()
  }
}
