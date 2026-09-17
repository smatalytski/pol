import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrate'

describe('VACUUM INTO snapshot', () => {
  it('produces an openable copy containing the cards and their media', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fiszki-'))
    const live = new Database(join(dir, 'live.db'))
    live.pragma('journal_mode = WAL')
    migrate(live)
    live
      .prepare(
        `INSERT INTO media (id, kind, mime, bytes, byte_size, created_at) VALUES ('m', 'audio', 'audio/webm', ?, 3, 1)`,
      )
      .run(Buffer.from([1, 2, 3]))

    // Taken while the source connection is open and in WAL mode — the case a
    // plain file copy gets wrong.
    const backup = join(dir, 'backup.db')
    live.prepare(`VACUUM INTO ?`).run(backup)

    const copy = new Database(backup, { readonly: true })
    const row = copy.prepare('SELECT byte_size, bytes FROM media WHERE id = ?').get('m') as {
      byte_size: number
      bytes: Buffer
    }
    expect(row.byte_size).toBe(3)
    expect([...row.bytes]).toEqual([1, 2, 3])
    expect(copy.prepare("SELECT count(*) n FROM sqlite_master WHERE name='cards'").get()).toEqual({ n: 1 })
  })
})
