import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = process.cwd()
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations')
const MIGRATE_TS = fileURLToPath(new URL('./migrate.ts', import.meta.url))
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')
const WORKERS = 8

// Absolute paths, so this script works regardless of which tmp directory it
// is written into — module resolution for a bare specifier like
// 'better-sqlite3' walks up from the *script's own* location, not from cwd,
// and a tmp directory has no node_modules above it.
const WORKER_SCRIPT = `
import Database from ${JSON.stringify(BETTER_SQLITE3)}
import { migrate } from ${JSON.stringify(MIGRATE_TS)}

// Mirrors lib/db/client.ts exactly: open, pragma, migrate.
const sqlite = new Database(process.argv[2])
sqlite.pragma('busy_timeout = 5000')
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
migrate(sqlite)
sqlite.close()
`

function runChild(workerFile: string, dbFile: string): Promise<{ code: number | null; stderr: string }> {
  // cwd is the repo root, on purpose: migrate() resolves the migrations
  // directory from process.cwd(), exactly as it does inside `next build`.
  const child = spawn('node', ['--experimental-strip-types', workerFile, dbFile], { cwd: REPO_ROOT })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })))
}

describe('migrate() under concurrent processes', () => {
  // Reproduces what a `next build` does: it spawns several worker processes
  // that each import lib/db/client.ts, which calls migrate() on module load.
  // Task 11's production deploy moves the database aside before building, and
  // this task drops the local dev DB — both leave `next build` to migrate a
  // brand-new, empty file from more than one process at once.
  it('applies every pending migration exactly once against a fresh database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiszki-migrate-race-'))
    const dbFile = join(dir, 'race.db')
    const workerFile = join(dir, 'worker.mjs')
    writeFileSync(workerFile, WORKER_SCRIPT)
    try {
      // No await between spawns: all WORKERS children start racing the same
      // brand-new file before any of them can finish.
      const children = Array.from({ length: WORKERS }, () => runChild(workerFile, dbFile))
      const results = await Promise.all(children)

      const failed = results.filter((r) => r.code !== 0)
      expect(
        failed,
        `expected all ${WORKERS} children to exit 0; failures:\n${failed.map((f) => f.stderr).join('\n---\n')}`,
      ).toEqual([])

      const verify = new Database(dbFile)
      try {
        const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
        const rows = (verify.prepare('SELECT name FROM _migrations').all() as { name: string }[])
          .map((r) => r.name)
          .sort()
        expect(rows).toEqual(sqlFiles)
      } finally {
        verify.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})
